import type { CoworkStore } from '../store';
import { type CoworkMemoryGuardLevel, isQuestionLikeMemoryText } from './coworkMemoryExtractor';
import { escapeXml } from './coworkRunnerHelpers';
import { coworkLog } from './coworkLogger';

const MEMORY_REQUEST_TAIL_SPLIT_RE = /[,，。]\s*(?:请|麻烦)?你(?:帮我|帮忙|给我|为我|看下|看一下|查下|查一下)|[,，。]\s*帮我|[,，。]\s*请帮我|[,，。]\s*(?:能|可以)不能?\s*帮我|[,，。]\s*你看|[,，。]\s*请你/i;
const MEMORY_PROCEDURAL_TEXT_RE = /(执行以下命令|run\s+(?:the\s+)?following\s+command|\b(?:cd|npm|pnpm|yarn|node|python|bash|sh|git|curl|wget)\b|\$[A-Z_][A-Z0-9_]*|&&|--[a-z0-9-]+|\/tmp\/|\.sh\b|\.bat\b|\.ps1\b)/i;
const MEMORY_ASSISTANT_STYLE_TEXT_RE = /^(?:使用|use)\s+[A-Za-z0-9._-]+\s*(?:技能|skill)/i;

export interface QueuedTurnMemoryUpdate {
  key: string;
  sessionId: string;
  userText: string;
  assistantText: string;
  implicitEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  guardLevel: CoworkMemoryGuardLevel;
  userMessageId?: string;
  assistantMessageId?: string;
  enqueuedAt: number;
}

export function applyTurnMemoryUpdatesForSession(
  store: CoworkStore,
  sessionId: string,
  turnMemoryQueueKeys: Set<string>,
  lastTurnMemoryKeyBySession: Map<string, string>
): QueuedTurnMemoryUpdate | null {
  const config = store.getConfig();
  if (!config.memoryEnabled) {
    return null;
  }

  const session = store.getSession(sessionId);
  if (!session || session.messages.length === 0) {
    return null;
  }

  const lastUser = [...session.messages].reverse().find((message) => message.type === 'user' && message.content?.trim());
  const lastAssistant = [...session.messages].reverse().find((message) => {
    if (message.type !== 'assistant') return false;
    if (!message.content?.trim()) return false;
    if (message.metadata?.isThinking) return false;
    return true;
  });

  if (!lastUser || !lastAssistant) {
    return null;
  }

  const key = `${sessionId}:${lastUser.id}:${lastAssistant.id}`;
  if (lastTurnMemoryKeyBySession.get(sessionId) === key || turnMemoryQueueKeys.has(key)) {
    return null;
  }

  const job: QueuedTurnMemoryUpdate = {
    key,
    sessionId,
    userText: lastUser.content,
    assistantText: lastAssistant.content,
    implicitEnabled: config.memoryImplicitUpdateEnabled,
    memoryLlmJudgeEnabled: config.memoryLlmJudgeEnabled,
    guardLevel: config.memoryGuardLevel,
    userMessageId: lastUser.id,
    assistantMessageId: lastAssistant.id,
    enqueuedAt: Date.now(),
  };

  turnMemoryQueueKeys.add(key);
  return job;
}

export async function drainTurnMemoryQueue(
  store: CoworkStore,
  turnMemoryQueue: QueuedTurnMemoryUpdate[],
  turnMemoryQueueKeys: Set<string>,
  lastTurnMemoryKeyBySession: Map<string, string>
): Promise<void> {
  while (turnMemoryQueue.length > 0) {
    const job = turnMemoryQueue.shift();
    if (!job) continue;
    try {
      const result = await store.applyTurnMemoryUpdates({
        sessionId: job.sessionId,
        userText: job.userText,
        assistantText: job.assistantText,
        implicitEnabled: job.implicitEnabled,
        memoryLlmJudgeEnabled: job.memoryLlmJudgeEnabled,
        guardLevel: job.guardLevel,
        userMessageId: job.userMessageId,
        assistantMessageId: job.assistantMessageId,
      });
      coworkLog('INFO', 'memory:turnUpdateAsync', 'Applied turn memory updates asynchronously', {
        sessionId: job.sessionId,
        queueSize: turnMemoryQueue.length,
        latencyMs: Math.max(0, Date.now() - job.enqueuedAt),
        ...result,
      });
    } catch (error) {
      coworkLog('WARN', 'memory:turnUpdateAsync', 'Failed to apply turn memory updates asynchronously', {
        sessionId: job.sessionId,
        queueSize: turnMemoryQueue.length,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      lastTurnMemoryKeyBySession.set(job.sessionId, job.key);
      turnMemoryQueueKeys.delete(job.key);
    }
  }
}

export function buildUserMemoriesXml(store: CoworkStore): string {
  const config = store.getConfig();
  if (!config.memoryEnabled) {
    return '<userMemories></userMemories>';
  }

  const memories = store.listUserMemories({
    status: 'created',
    includeDeleted: false,
    limit: config.memoryUserMemoriesMaxItems,
    offset: 0,
  });

  if (memories.length === 0) {
    return '<userMemories></userMemories>';
  }

  const MAX_ITEM_CHARS = 200;
  const MAX_TOTAL_CHARS = 2000;
  let totalChars = 0;
  const lines: string[] = [];
  for (const memory of memories) {
    const text = memory.text.length > MAX_ITEM_CHARS
      ? memory.text.slice(0, MAX_ITEM_CHARS) + '...'
      : memory.text;
    const line = `- ${escapeXml(text)}`;
    if (totalChars + line.length > MAX_TOTAL_CHARS) break;
    lines.push(line);
    totalChars += line.length;
  }
  return `<userMemories>\n${lines.join('\n')}\n</userMemories>`;
}

export function formatChatSearchOutput(records: Array<{
  url: string;
  updatedAt: number;
  title: string;
  human: string;
  assistant: string;
}>): string {
  if (records.length === 0) {
    return 'No matching chats found.';
  }

  return records.map((record) => {
    const updatedAtIso = new Date(record.updatedAt || Date.now()).toISOString();
    return [
      `<chat url="${escapeXml(record.url)}" updated_at="${updatedAtIso}">`,
      `Title: ${record.title || 'Untitled'}`,
      `Human: ${(record.human || '').trim() || '(empty)'}`,
      `Assistant: ${(record.assistant || '').trim() || '(empty)'}`,
      '</chat>',
    ].join('\n');
  }).join('\n\n');
}

export function formatMemoryUserEditsResult(input: {
  action: 'list' | 'add' | 'update' | 'delete';
  successCount: number;
  failedCount: number;
  changedIds: string[];
  reason?: string;
  payload?: string;
}): string {
  const parts = [
    `action=${input.action}`,
    `success=${input.successCount}`,
    `failed=${input.failedCount}`,
    `changed_ids=${input.changedIds.join(',') || '-'}`,
  ];
  if (input.reason) {
    parts.push(`reason=${input.reason}`);
  }
  if (input.payload) {
    parts.push(input.payload);
  }
  return parts.join('\n');
}

export function sanitizeMemoryToolText(raw: string): string {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  const tailMatch = normalized.match(MEMORY_REQUEST_TAIL_SPLIT_RE);
  const clipped = tailMatch?.index && tailMatch.index > 0
    ? normalized.slice(0, tailMatch.index)
    : normalized;
  return clipped.replace(/[，,；;:\-]+$/, '').trim();
}

export function validateMemoryToolText(rawText: string): { ok: boolean; text: string; reason?: string } {
  const text = sanitizeMemoryToolText(rawText);
  if (!text) {
    return { ok: false, text: '', reason: 'text is required' };
  }
  if (isQuestionLikeMemoryText(text)) {
    return { ok: false, text: '', reason: 'memory text looks like a question, not a durable fact' };
  }
  if (MEMORY_ASSISTANT_STYLE_TEXT_RE.test(text)) {
    return { ok: false, text: '', reason: 'memory text looks like assistant workflow instruction' };
  }
  if (MEMORY_PROCEDURAL_TEXT_RE.test(text)) {
    return { ok: false, text: '', reason: 'memory text looks like command/procedural content' };
  }
  return { ok: true, text };
}

function runConversationSearchTool(
  store: CoworkStore,
  args: {
    query: string;
    max_results?: number;
    before?: string;
    after?: string;
  }
): string {
  const chats = store.conversationSearch({
    query: args.query,
    maxResults: args.max_results,
    before: args.before,
    after: args.after,
  });
  return formatChatSearchOutput(chats);
}

function runRecentChatsTool(
  store: CoworkStore,
  args: {
    n?: number;
    sort_order?: 'asc' | 'desc';
    before?: string;
    after?: string;
  }
): string {
  const chats = store.recentChats({
    n: args.n,
    sortOrder: args.sort_order,
    before: args.before,
    after: args.after,
  });
  return formatChatSearchOutput(chats);
}

function runMemoryUserEditsTool(
  store: CoworkStore,
  args: {
    action: 'list' | 'add' | 'update' | 'delete';
    id?: string;
    text?: string;
    confidence?: number;
    status?: 'created' | 'stale' | 'deleted';
    is_explicit?: boolean;
    limit?: number;
    query?: string;
  }
): { text: string; isError: boolean } {
  if (args.action === 'list') {
    const entries = store.listUserMemories({
      query: args.query,
      status: 'all',
      includeDeleted: true,
      limit: args.limit ?? 20,
      offset: 0,
    });
    const payload = entries.length === 0
      ? 'memories=(empty)'
      : entries
        .map((entry) => `${entry.id} | ${entry.status} | explicit=${entry.isExplicit ? 1 : 0} | ${entry.text}`)
        .join('\n');
    return {
      text: formatMemoryUserEditsResult({
        action: 'list',
        successCount: entries.length,
        failedCount: 0,
        changedIds: entries.map((entry) => entry.id),
        payload,
      }),
      isError: false,
    };
  }

  if (args.action === 'add') {
    const text = args.text?.trim();
    if (!text) {
      return {
        text: formatMemoryUserEditsResult({
          action: 'add',
          successCount: 0,
          failedCount: 1,
          changedIds: [],
          reason: 'text is required',
        }),
        isError: true,
      };
    }
    const validation = validateMemoryToolText(text);
    if (!validation.ok) {
      return {
        text: formatMemoryUserEditsResult({
          action: 'add',
          successCount: 0,
          failedCount: 1,
          changedIds: [],
          reason: validation.reason,
        }),
        isError: true,
      };
    }
    const entry = store.createUserMemory({
      text: validation.text,
      confidence: args.confidence,
      isExplicit: args.is_explicit ?? true,
    });
    return {
      text: formatMemoryUserEditsResult({
        action: 'add',
        successCount: 1,
        failedCount: 0,
        changedIds: [entry.id],
      }),
      isError: false,
    };
  }

  if (args.action === 'update') {
    if (!args.id?.trim()) {
      return {
        text: formatMemoryUserEditsResult({
          action: 'update',
          successCount: 0,
          failedCount: 1,
          changedIds: [],
          reason: 'id is required',
        }),
        isError: true,
      };
    }
    if (typeof args.text === 'string') {
      const validation = validateMemoryToolText(args.text);
      if (!validation.ok) {
        return {
          text: formatMemoryUserEditsResult({
            action: 'update',
            successCount: 0,
            failedCount: 1,
            changedIds: [],
            reason: validation.reason,
          }),
          isError: true,
        };
      }
      args.text = validation.text;
    }
    const updated = store.updateUserMemory({
      id: args.id.trim(),
      text: args.text,
      confidence: args.confidence,
      status: args.status,
      isExplicit: args.is_explicit,
    });
    if (!updated) {
      return {
        text: formatMemoryUserEditsResult({
          action: 'update',
          successCount: 0,
          failedCount: 1,
          changedIds: [],
          reason: 'memory not found',
        }),
        isError: true,
      };
    }
    return {
      text: formatMemoryUserEditsResult({
        action: 'update',
        successCount: 1,
        failedCount: 0,
        changedIds: [updated.id],
      }),
      isError: false,
    };
  }

  if (!args.id?.trim()) {
    return {
      text: formatMemoryUserEditsResult({
        action: 'delete',
        successCount: 0,
        failedCount: 1,
        changedIds: [],
        reason: 'id is required',
      }),
      isError: true,
    };
  }

  const deleted = store.deleteUserMemory(args.id.trim());
  return {
    text: formatMemoryUserEditsResult({
      action: 'delete',
      successCount: deleted ? 1 : 0,
      failedCount: deleted ? 0 : 1,
      changedIds: deleted ? [args.id.trim()] : [],
      reason: deleted ? undefined : 'memory not found',
    }),
    isError: !deleted,
  };
}

export function handleHostToolExecution(
  store: CoworkStore,
  payload: Record<string, unknown>
): { success: boolean; text: string } {
  const toolName = String(payload.toolName ?? payload.name ?? '');
  const rawInput = payload.toolInput ?? payload.input ?? {};
  const toolInput =
    rawInput && typeof rawInput === 'object'
      ? (rawInput as Record<string, unknown>)
      : {};

  try {
    if (toolName === 'conversation_search') {
      const text = runConversationSearchTool(store, {
        query: String(toolInput.query ?? ''),
        max_results: typeof toolInput.max_results === 'number' ? toolInput.max_results : undefined,
        before: typeof toolInput.before === 'string' ? toolInput.before : undefined,
        after: typeof toolInput.after === 'string' ? toolInput.after : undefined,
      });
      return { success: true, text };
    }

    if (toolName === 'recent_chats') {
      const sortOrder = toolInput.sort_order === 'asc' || toolInput.sort_order === 'desc'
        ? toolInput.sort_order
        : undefined;
      const text = runRecentChatsTool(store, {
        n: typeof toolInput.n === 'number' ? toolInput.n : undefined,
        sort_order: sortOrder,
        before: typeof toolInput.before === 'string' ? toolInput.before : undefined,
        after: typeof toolInput.after === 'string' ? toolInput.after : undefined,
      });
      return { success: true, text };
    }

    if (toolName === 'memory_user_edits') {
      const action = toolInput.action;
      if (action !== 'list' && action !== 'add' && action !== 'update' && action !== 'delete') {
        return {
          success: false,
          text: formatMemoryUserEditsResult({
            action: 'list',
            successCount: 0,
            failedCount: 1,
            changedIds: [],
            reason: 'action is required: list|add|update|delete',
          }),
        };
      }
      const result = runMemoryUserEditsTool(store, {
        action,
        id: typeof toolInput.id === 'string' ? toolInput.id : undefined,
        text: typeof toolInput.text === 'string' ? toolInput.text : undefined,
        confidence: typeof toolInput.confidence === 'number' ? toolInput.confidence : undefined,
        status: toolInput.status === 'created' || toolInput.status === 'stale' || toolInput.status === 'deleted'
          ? toolInput.status
          : undefined,
        is_explicit: typeof toolInput.is_explicit === 'boolean' ? toolInput.is_explicit : undefined,
        limit: typeof toolInput.limit === 'number' ? toolInput.limit : undefined,
        query: typeof toolInput.query === 'string' ? toolInput.query : undefined,
      });
      return {
        success: !result.isError,
        text: result.text,
      };
    }

    return { success: false, text: `Unsupported host tool: ${toolName || '(empty)'}` };
  } catch (error) {
    return {
      success: false,
      text: error instanceof Error ? error.message : String(error),
    };
  }
}
