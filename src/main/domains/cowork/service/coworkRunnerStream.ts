import type { CoworkStore, CoworkMessage, CoworkExecutionMode } from '../store';
import type { PermissionRequest } from './coworkRunner';
import { PermissionManager } from './coworkRunnerPermission';
import { truncateLargeContent, extractText, formatToolResultContent } from './coworkRunnerHelpers';
import { sanitizeToolPayload } from './coworkRunnerSafety';
import { applyTurnMemoryUpdatesForSession } from './coworkRunnerMemory';
import { coworkLog } from './coworkLogger';

const STREAM_UPDATE_THROTTLE_MS = 90;
const STREAMING_TEXT_MAX_CHARS = 120_000;
const STREAMING_THINKING_MAX_CHARS = 60_000;
const FINAL_RESULT_MAX_CHARS = 120_000;
const CONTENT_TRUNCATED_HINT = '\n...[truncated to prevent memory pressure]';

// Re-export ActiveSession interface so the new module can reference it
export interface ActiveSession {
  sessionId: string;
  claudeSessionId: string | null;
  workspaceRoot: string;
  confirmationMode: 'modal' | 'text';
  pendingPermission: PermissionRequest | null;
  abortController: AbortController;
  currentStreamingMessageId: string | null;
  currentStreamingContent: string;
  currentStreamingThinkingMessageId: string | null;
  currentStreamingThinking: string;
  currentStreamingBlockType: 'thinking' | 'text' | null;
  currentStreamingTextTruncated: boolean;
  currentStreamingThinkingTruncated: boolean;
  lastStreamingTextUpdateAt: number;
  lastStreamingThinkingUpdateAt: number;
  hasAssistantTextOutput: boolean;
  hasAssistantThinkingOutput: boolean;
  executionMode: CoworkExecutionMode;
  sandboxTurnResolve?: (result: { status: 'ok' } | { status: 'error'; message: string; hvfDenied: boolean; memoryFailed: boolean }) => void;
  autoApprove?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

export function appendStreamingDelta(
  current: string,
  delta: string,
  maxChars: number,
  isTruncated: boolean
): { content: string; truncated: boolean; changed: boolean } {
  if (!delta || isTruncated) {
    return { content: current, truncated: isTruncated, changed: false };
  }

  const nextLength = current.length + delta.length;
  if (nextLength <= maxChars) {
    return { content: current + delta, truncated: false, changed: true };
  }

  const remaining = Math.max(0, maxChars - current.length);
  const head = remaining > 0 ? `${current}${delta.slice(0, remaining)}` : current;
  return {
    content: `${head}${CONTENT_TRUNCATED_HINT}`,
    truncated: true,
    changed: true,
  };
}

export function shouldEmitStreamingUpdate(
  lastEmitAt: number,
  force = false
): { emit: boolean; now: number } {
  const now = Date.now();
  if (force || now - lastEmitAt >= STREAM_UPDATE_THROTTLE_MS) {
    return { emit: true, now };
  }
  return { emit: false, now };
}

export function normalizeSdkError(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase() === 'unknown') {
    return null;
  }
  return trimmed;
}

export function resolveAssistantEventError(payload: Record<string, unknown>): string | null {
  const directError = normalizeSdkError(payload.error);
  if (directError) {
    return directError;
  }
  if (typeof payload.error !== 'string' || payload.error.trim().toLowerCase() !== 'unknown') {
    return null;
  }

  const messagePayload = payload.message;
  if (!messagePayload || typeof messagePayload !== 'object') {
    return null;
  }
  const content = (messagePayload as Record<string, unknown>).content;
  const inferredError = extractText(content)?.trim();
  if (!inferredError) {
    return null;
  }
  return inferredError;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers that need store access                            */
/* ------------------------------------------------------------------ */

function getMessageById(
  store: CoworkStore,
  sessionId: string,
  messageId: string
): CoworkMessage | undefined {
  const session = store.getSession(sessionId);
  return session?.messages.find((message) => message.id === messageId);
}

export function updateMessageMerged(
  store: CoworkStore,
  sessionId: string,
  messageId: string,
  updates: { content?: string; metadata?: CoworkMessage['metadata'] }
): void {
  const existing = getMessageById(store, sessionId, messageId);
  const mergedMetadata = updates.metadata
    ? { ...(existing?.metadata ?? {}), ...updates.metadata }
    : undefined;

  store.updateMessage(sessionId, messageId, {
    content: updates.content,
    metadata: mergedMetadata,
  });
}

/* ------------------------------------------------------------------ */
/*  Streaming lifecycle helpers                                        */
/* ------------------------------------------------------------------ */

export function finalizeStreamingContent(
  activeSession: ActiveSession,
  store: CoworkStore,
  emit: (event: string, ...args: unknown[]) => void
): void {
  const { sessionId } = activeSession;

  // Finalize any pending thinking message
  if (activeSession.currentStreamingThinkingMessageId) {
    updateMessageMerged(store, sessionId, activeSession.currentStreamingThinkingMessageId, {
      content: activeSession.currentStreamingThinking,
      metadata: { isStreaming: false },
    });
    emit('messageUpdate', sessionId, activeSession.currentStreamingThinkingMessageId, activeSession.currentStreamingThinking);
  }
  activeSession.currentStreamingThinkingMessageId = null;
  activeSession.currentStreamingThinking = '';
  activeSession.currentStreamingThinkingTruncated = false;
  activeSession.lastStreamingThinkingUpdateAt = 0;

  // Finalize any pending text message
  const { currentStreamingMessageId, currentStreamingContent } = activeSession;
  if (currentStreamingMessageId) {
    updateMessageMerged(store, sessionId, currentStreamingMessageId, {
      content: currentStreamingContent,
      metadata: { isStreaming: false },
    });
    emit('messageUpdate', sessionId, currentStreamingMessageId, currentStreamingContent);
  }
  activeSession.currentStreamingMessageId = null;
  activeSession.currentStreamingContent = '';
  activeSession.currentStreamingTextTruncated = false;
  activeSession.lastStreamingTextUpdateAt = 0;
  activeSession.currentStreamingBlockType = null;
}

/* ------------------------------------------------------------------ */
/*  Stream event handler                                               */
/* ------------------------------------------------------------------ */

export function handleStreamEvent(
  sessionId: string,
  payload: Record<string, unknown>,
  activeSession: ActiveSession,
  deps: {
    store: CoworkStore;
    emit: (event: string, ...args: unknown[]) => void;
  }
): void {
  const { store, emit } = deps;

  // SDKPartialAssistantMessage structure:
  // { type: 'stream_event', event: BetaRawMessageStreamEvent, ... }
  const event = payload.event as Record<string, unknown> | undefined;
  if (!event || typeof event !== 'object') return;

  const eventType = String(event.type ?? '');

  // Handle content_block_start - create a new streaming message
  if (eventType === 'content_block_start') {
    const contentBlock = event.content_block as Record<string, unknown> | undefined;
    if (!contentBlock) return;

    const blockType = String(contentBlock.type ?? '');
    if (blockType === 'thinking') {
      // Start a new thinking message for streaming
      const initialThinkingRaw = typeof contentBlock.thinking === 'string' ? contentBlock.thinking : '';
      const initialThinking = truncateLargeContent(initialThinkingRaw, STREAMING_THINKING_MAX_CHARS);
      activeSession.currentStreamingThinking = initialThinking;
      activeSession.currentStreamingThinkingTruncated = initialThinking.length < initialThinkingRaw.length;
      activeSession.lastStreamingThinkingUpdateAt = 0;
      activeSession.currentStreamingBlockType = 'thinking';

      if (initialThinking.length > 0) {
        const message = store.addMessage(sessionId, {
          type: 'assistant',
          content: initialThinking,
          metadata: { isThinking: true, isStreaming: true },
        });
        activeSession.hasAssistantThinkingOutput = true;
        activeSession.currentStreamingThinkingMessageId = message.id;
        emit('message', sessionId, message);
      } else {
        activeSession.currentStreamingThinkingMessageId = null;
      }
    } else if (blockType === 'text') {
      // Start a new assistant message for streaming
      const initialTextRaw = typeof contentBlock.text === 'string' ? contentBlock.text : '';
      const initialText = truncateLargeContent(initialTextRaw, STREAMING_TEXT_MAX_CHARS);
      activeSession.currentStreamingContent = initialText;
      activeSession.currentStreamingTextTruncated = initialText.length < initialTextRaw.length;
      activeSession.lastStreamingTextUpdateAt = 0;
      activeSession.currentStreamingBlockType = 'text';

      if (initialText.length > 0) {
        const message = store.addMessage(sessionId, {
          type: 'assistant',
          content: initialText,
          metadata: { isStreaming: true },
        });
        activeSession.hasAssistantTextOutput = true;
        activeSession.currentStreamingMessageId = message.id;
        emit('message', sessionId, message);
      } else {
        activeSession.currentStreamingMessageId = null;
      }
    }
    return;
  }

  // Handle content_block_delta - update the streaming message
  if (eventType === 'content_block_delta') {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (!delta) return;

    const deltaType = String(delta.type ?? '');

    if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
      if (delta.thinking.length === 0) return;
      const next = appendStreamingDelta(
        activeSession.currentStreamingThinking,
        delta.thinking,
        STREAMING_THINKING_MAX_CHARS,
        activeSession.currentStreamingThinkingTruncated
      );
      activeSession.currentStreamingThinking = next.content;
      activeSession.currentStreamingThinkingTruncated = next.truncated;
      activeSession.hasAssistantThinkingOutput = true;

      if (activeSession.currentStreamingThinkingMessageId) {
        if (!next.changed) {
          return;
        }
        const streamTick = shouldEmitStreamingUpdate(activeSession.lastStreamingThinkingUpdateAt);
        if (streamTick.emit) {
          activeSession.lastStreamingThinkingUpdateAt = streamTick.now;
          emit('messageUpdate', sessionId, activeSession.currentStreamingThinkingMessageId, activeSession.currentStreamingThinking);
        }
      } else {
        // No thinking message yet, create one
        const message = store.addMessage(sessionId, {
          type: 'assistant',
          content: activeSession.currentStreamingThinking,
          metadata: { isThinking: true, isStreaming: true },
        });
        activeSession.currentStreamingThinkingMessageId = message.id;
        activeSession.lastStreamingThinkingUpdateAt = Date.now();
        emit('message', sessionId, message);
      }
      return;
    }

    if (deltaType === 'text_delta' && typeof delta.text === 'string') {
      if (delta.text.length === 0) return;
      const next = appendStreamingDelta(
        activeSession.currentStreamingContent,
        delta.text,
        STREAMING_TEXT_MAX_CHARS,
        activeSession.currentStreamingTextTruncated
      );
      activeSession.currentStreamingContent = next.content;
      activeSession.currentStreamingTextTruncated = next.truncated;

      // If we have a streaming message, emit update; otherwise create one
      if (activeSession.currentStreamingMessageId) {
        activeSession.hasAssistantTextOutput = true;
        if (!next.changed) {
          return;
        }
        const streamTick = shouldEmitStreamingUpdate(activeSession.lastStreamingTextUpdateAt);
        if (streamTick.emit) {
          activeSession.lastStreamingTextUpdateAt = streamTick.now;
          emit('messageUpdate', sessionId, activeSession.currentStreamingMessageId, activeSession.currentStreamingContent);
        }
      } else {
        // No message yet, create one
        const message = store.addMessage(sessionId, {
          type: 'assistant',
          content: activeSession.currentStreamingContent,
          metadata: { isStreaming: true },
        });
        activeSession.hasAssistantTextOutput = true;
        activeSession.currentStreamingMessageId = message.id;
        activeSession.lastStreamingTextUpdateAt = Date.now();
        emit('message', sessionId, message);
      }
    }
    return;
  }

  // Handle content_block_stop - finalize the streaming message
  if (eventType === 'content_block_stop') {
    const blockType = activeSession.currentStreamingBlockType;

    if (blockType === 'thinking') {
      // Finalize thinking message
      if (activeSession.currentStreamingThinkingMessageId && activeSession.currentStreamingThinking) {
        updateMessageMerged(store, sessionId, activeSession.currentStreamingThinkingMessageId, {
          content: activeSession.currentStreamingThinking,
          metadata: { isStreaming: false },
        });
        emit('messageUpdate', sessionId, activeSession.currentStreamingThinkingMessageId, activeSession.currentStreamingThinking);
      }
      activeSession.currentStreamingThinkingMessageId = null;
      activeSession.currentStreamingThinking = '';
      activeSession.currentStreamingThinkingTruncated = false;
      activeSession.lastStreamingThinkingUpdateAt = 0;
    } else {
      // Finalize text message (existing behavior)
      if (activeSession.currentStreamingMessageId && activeSession.currentStreamingContent) {
        updateMessageMerged(store, sessionId, activeSession.currentStreamingMessageId, {
          content: activeSession.currentStreamingContent,
          metadata: { isStreaming: false },
        });
        emit('messageUpdate', sessionId, activeSession.currentStreamingMessageId, activeSession.currentStreamingContent);
      }
      activeSession.currentStreamingMessageId = null;
      activeSession.currentStreamingContent = '';
      activeSession.currentStreamingTextTruncated = false;
      activeSession.lastStreamingTextUpdateAt = 0;
    }

    activeSession.currentStreamingBlockType = null;
    return;
  }

  // Handle message_stop - ensure everything is finalized
  if (eventType === 'message_stop') {
    // Finalize any pending thinking message
    if (activeSession.currentStreamingThinkingMessageId && activeSession.currentStreamingThinking) {
      updateMessageMerged(store, sessionId, activeSession.currentStreamingThinkingMessageId, {
        content: activeSession.currentStreamingThinking,
        metadata: { isStreaming: false },
      });
      emit('messageUpdate', sessionId, activeSession.currentStreamingThinkingMessageId, activeSession.currentStreamingThinking);
    }
    activeSession.currentStreamingThinkingMessageId = null;
    activeSession.currentStreamingThinking = '';
    activeSession.currentStreamingThinkingTruncated = false;
    activeSession.lastStreamingThinkingUpdateAt = 0;

    // Finalize any pending text message
    if (activeSession.currentStreamingMessageId && activeSession.currentStreamingContent) {
      updateMessageMerged(store, sessionId, activeSession.currentStreamingMessageId, {
        content: activeSession.currentStreamingContent,
        metadata: { isStreaming: false },
      });
      emit('messageUpdate', sessionId, activeSession.currentStreamingMessageId, activeSession.currentStreamingContent);
    }
    activeSession.currentStreamingMessageId = null;
    activeSession.currentStreamingContent = '';
    activeSession.currentStreamingTextTruncated = false;
    activeSession.lastStreamingTextUpdateAt = 0;
    activeSession.currentStreamingBlockType = null;
    return;
  }
}

/* ------------------------------------------------------------------ */
/*  Persist final result                                               */
/* ------------------------------------------------------------------ */

export function persistFinalResult(
  sessionId: string,
  activeSession: ActiveSession,
  store: CoworkStore,
  emit: (event: string, ...args: unknown[]) => void,
  resultText: string
): void {
  const safeResultText = truncateLargeContent(resultText, FINAL_RESULT_MAX_CHARS);
  const trimmed = safeResultText.trim();
  if (!trimmed) return;

  // If we have an active streaming message, prefer updating it with the final result.
  // This avoids duplicate assistant messages when result arrives before streaming completes.
  if (activeSession.currentStreamingMessageId) {
    // 优先保留已累积的流式内容，只有在流式内容为空时才使用 resultText
    // 这样可以防止 result 事件覆盖已接收的流式内容
    const finalContent = activeSession.currentStreamingContent.trim()
      ? activeSession.currentStreamingContent
      : safeResultText;

    updateMessageMerged(store, sessionId, activeSession.currentStreamingMessageId, {
      content: finalContent,
      metadata: { isFinal: true, isStreaming: false },
    });
    emit('messageUpdate', sessionId, activeSession.currentStreamingMessageId, finalContent);

    // 更新后立即重置状态，防止被后续事件重复处理
    activeSession.currentStreamingMessageId = null;
    activeSession.currentStreamingContent = '';
    return;
  }

  // Check if we already have assistant output with the same content
  // This catches the case where streaming is complete but hasAssistantTextOutput is set
  if (activeSession.hasAssistantTextOutput) {
    const session = store.getSession(sessionId);
    const lastAssistant = session?.messages.slice().reverse().find((message) => message.type === 'assistant');
    if (lastAssistant && lastAssistant.content?.trim() === trimmed) {
      // Content is the same, just update metadata
      updateMessageMerged(store, sessionId, lastAssistant.id, {
        metadata: { isFinal: true, isStreaming: false },
      });
      return;
    }
  }

  const session = store.getSession(sessionId);
  const lastAssistant = session?.messages.slice().reverse().find((message) => message.type === 'assistant');
  const lastAssistantText = lastAssistant?.content?.trim() ?? '';

  // If the last assistant message is a streaming placeholder (empty or still marked streaming),
  // update it with the final result instead of adding a new message.
  if (lastAssistant && (lastAssistant.metadata?.isStreaming || lastAssistantText.length === 0)) {
    updateMessageMerged(store, sessionId, lastAssistant.id, {
      content: safeResultText,
      metadata: { isFinal: true, isStreaming: false },
    });
    emit('messageUpdate', sessionId, lastAssistant.id, safeResultText);
    return;
  }

  if (lastAssistant && lastAssistantText === trimmed) {
    updateMessageMerged(store, sessionId, lastAssistant.id, {
      content: safeResultText,
      metadata: { isFinal: true, isStreaming: false },
    });
    emit('messageUpdate', sessionId, lastAssistant.id, safeResultText);
    return;
  }

  const message = store.addMessage(sessionId, {
    type: 'assistant',
    content: safeResultText,
    metadata: { isFinal: true },
  });
  emit('message', sessionId, message);
}

/* ------------------------------------------------------------------ */
/*  Main Claude event router                                           */
/* ------------------------------------------------------------------ */

export function handleClaudeEvent(
  sessionId: string,
  event: unknown,
  activeSession: ActiveSession,
  deps: {
    store: CoworkStore;
    emit: (event: string, ...args: unknown[]) => void;
    permissionManager: PermissionManager;
    handleError: (sessionId: string, error: string) => void;
    isSessionStopRequested: (sessionId: string, activeSession?: ActiveSession) => boolean;
    applyTurnMemoryUpdatesForSession: (sessionId: string) => void;
  }
): void {
  const { store, emit, permissionManager, handleError, isSessionStopRequested, applyTurnMemoryUpdatesForSession } = deps;

  if (isSessionStopRequested(sessionId, activeSession)) {
    return;
  }

  const markAssistantTextOutput = () => {
    activeSession.hasAssistantTextOutput = true;
  };
  const markAssistantThinkingOutput = () => {
    activeSession.hasAssistantThinkingOutput = true;
  };

  if (typeof event === 'string') {
    const message = store.addMessage(sessionId, {
      type: 'assistant',
      content: event,
    });
    markAssistantTextOutput();
    emit('message', sessionId, message);
    return;
  }

  if (!event || typeof event !== 'object') {
    return;
  }

  const payload = event as Record<string, unknown>;
  const eventType = String(payload.type ?? '');

  // Handle streaming events (SDKPartialAssistantMessage)
  if (eventType === 'stream_event') {
    handleStreamEvent(sessionId, payload, activeSession, { store, emit });
    return;
  }

  if (eventType === 'system') {
    const subtype = String(payload.subtype ?? '');
    if (subtype === 'init' && typeof payload.session_id === 'string') {
      activeSession.claudeSessionId = payload.session_id;
      store.updateSession(sessionId, { claudeSessionId: payload.session_id });
    }
    return;
  }

  if (eventType === 'auth_status') {
    const authError = normalizeSdkError(payload.error);
    if (authError) {
      handleError(sessionId, authError);
    }
    return;
  }

  if (eventType === 'result') {
    // Log token usage for observability
    const usage = (payload.usage ?? (payload.result && typeof payload.result === 'object' ? (payload.result as Record<string, unknown>).usage : undefined)) as Record<string, unknown> | undefined;
    if (usage) {
      coworkLog('INFO', 'tokenUsage', 'Turn token usage', {
        sessionId,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
      });
    }

    const subtype = String(payload.subtype ?? 'success');
    if (subtype !== 'success') {
      const errors = Array.isArray(payload.errors)
        ? payload.errors
          .filter((error) => typeof error === 'string')
          .map((error) => (error as string).trim())
          .filter((error) => error && error.toLowerCase() !== 'unknown')
        : [];
      const payloadError = normalizeSdkError(payload.error);
      const errorMessage =
        errors.length > 0
          ? errors.join('\n')
          : payloadError
            ? payloadError
            : 'Claude run failed';
      handleError(sessionId, errorMessage);
      return;
    }

    if (typeof payload.result === 'string' && payload.result.trim()) {
      persistFinalResult(sessionId, activeSession, store, emit, payload.result);
      markAssistantTextOutput();
    }

    // For sandbox mode, mark session as completed when we receive a successful result.
    // Keep the VM alive for multi-turn conversations instead of killing it.
    if (activeSession.executionMode === 'sandbox') {
      finalizeStreamingContent(activeSession, store, emit);
      const session = store.getSession(sessionId);
      if (session?.status !== 'error' && session?.status !== 'completed') {
        store.updateSession(sessionId, { status: 'completed' });
        applyTurnMemoryUpdatesForSession(sessionId);
        emit('complete', sessionId, activeSession.claudeSessionId);
      }
      // Signal turn completion — keep VM alive for multi-turn sandbox sessions
      if (activeSession.sandboxTurnResolve) {
        const resolve = activeSession.sandboxTurnResolve;
        activeSession.sandboxTurnResolve = undefined;
        resolve({ status: 'ok' });
      }
    }
    return;
  }

  if (eventType === 'user') {
    const messagePayload = payload.message;
    if (!messagePayload || typeof messagePayload !== 'object') {
      return;
    }

    const contentBlocks = (messagePayload as Record<string, unknown>).content;
    const blocks = Array.isArray(contentBlocks)
      ? contentBlocks
      : contentBlocks && typeof contentBlocks === 'object'
        ? [contentBlocks]
        : [];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      const blockType = String(record.type ?? '');
      if (blockType !== 'tool_result') continue;

      const content = formatToolResultContent(record);
      const isError = Boolean(record.is_error);
      const message = store.addMessage(sessionId, {
        type: 'tool_result',
        content,
        metadata: {
          toolResult: content,
          toolUseId: typeof record.tool_use_id === 'string' ? record.tool_use_id : null,
          error: isError ? content || 'Tool execution failed' : undefined,
          isError,
        },
      });
      emit('message', sessionId, message);
    }
    return;
  }

  if (eventType !== 'assistant') {
    return;
  }

  const assistantEventError = resolveAssistantEventError(payload);
  if (assistantEventError) {
    handleError(sessionId, assistantEventError);
  }

  // Check if we already have assistant text output from streaming
  // Use hasAssistantTextOutput flag instead of streaming state, because
  // content_block_stop may have already cleared the streaming state
  const hasStreamedText = activeSession.hasAssistantTextOutput;
  const hasStreamedThinking = activeSession.hasAssistantThinkingOutput;

  // Persist any pending streaming content before applying fallback assistant parsing.
  // This prevents losing streamed text when assistant event arrives before stop events.
  const hadPendingTextStreaming =
    activeSession.currentStreamingMessageId !== null || activeSession.currentStreamingContent !== '';
  const hadPendingThinkingStreaming =
    activeSession.currentStreamingThinkingMessageId !== null || activeSession.currentStreamingThinking !== '';
  if (hadPendingTextStreaming || hadPendingThinkingStreaming) {
    finalizeStreamingContent(activeSession, store, emit);
  }

  const messagePayload = payload.message;
  if (!messagePayload || typeof messagePayload !== 'object') {
    // Skip text messages if we already have streamed text output
    if (hasStreamedText || hadPendingTextStreaming) return;
    const content = extractText(messagePayload);
    if (content) {
      const message = store.addMessage(sessionId, {
        type: 'assistant',
        content,
      });
      markAssistantTextOutput();
      emit('message', sessionId, message);
    }
    return;
  }

  const contentBlocks = (messagePayload as Record<string, unknown>).content;
  if (!Array.isArray(contentBlocks)) {
    // Skip text messages if we already have streamed text output
    if (hasStreamedText || hadPendingTextStreaming) return;
    const content = extractText(contentBlocks ?? messagePayload);
    if (!content) return;
    const message = store.addMessage(sessionId, {
      type: 'assistant',
      content,
    });
    markAssistantTextOutput();
    emit('message', sessionId, message);
    return;
  }

  const textParts: string[] = [];
  const flushTextParts = () => {
    // Skip text messages if we already have streamed text output
    if (hasStreamedText || hadPendingTextStreaming || textParts.length === 0) return;
    const message = store.addMessage(sessionId, {
      type: 'assistant',
      content: textParts.join(''),
    });
    markAssistantTextOutput();
    emit('message', sessionId, message);
    textParts.length = 0;
  };
  for (const block of contentBlocks) {
    if (typeof block === 'string') {
      textParts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;

    const record = block as Record<string, unknown>;
    const blockType = String(record.type ?? '');

    if (blockType === 'thinking' && typeof record.thinking === 'string' && record.thinking.trim()) {
      if (hasStreamedThinking || hadPendingThinkingStreaming) {
        continue;
      }
      flushTextParts();
      const message = store.addMessage(sessionId, {
        type: 'assistant',
        content: record.thinking,
        metadata: { isThinking: true },
      });
      markAssistantThinkingOutput();
      emit('message', sessionId, message);
      continue;
    }

    if (blockType === 'text' && typeof record.text === 'string') {
      textParts.push(record.text);
      continue;
    }

    if (blockType === 'tool_use') {
      flushTextParts();
      const toolName = String(record.name ?? 'unknown');
      const toolInputRaw = record.input ?? {};
      const toolInput = toolInputRaw && typeof toolInputRaw === 'object'
        ? (toolInputRaw as Record<string, unknown>)
        : { value: toolInputRaw };
      const toolUseId = typeof record.id === 'string' ? record.id : null;

      const message = store.addMessage(sessionId, {
        type: 'tool_use',
        content: `Using tool: ${toolName}`,
        metadata: {
          toolName,
          toolInput: sanitizeToolPayload(toolInput) as Record<string, unknown>,
          toolUseId,
        },
      });
      emit('message', sessionId, message);
      continue;
    }

    if (blockType === 'tool_result') {
      flushTextParts();
      const content = formatToolResultContent(record);
      const isError = Boolean(record.is_error);
      const message = store.addMessage(sessionId, {
        type: 'tool_result',
        content,
        metadata: {
          toolResult: content,
          toolUseId: typeof record.tool_use_id === 'string' ? record.tool_use_id : null,
          error: isError ? content || 'Tool execution failed' : undefined,
          isError,
        },
      });
      emit('message', sessionId, message);
    }
  }

  flushTextParts();
}
