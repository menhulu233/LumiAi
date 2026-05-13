import http from 'http';
import {
  buildOpenAIChatCompletionsURL,
  formatSSEEvent,
  mapStopReason,
  type OpenAIStreamChunk,
} from './coworkFormatTransform';
import { toOptionalObject, toString, toArray, toNumber, normalizeToolCallExtraContent, normalizeFunctionArguments, ToolCallState } from './typeConversions';
import { cacheToolCallExtraContent } from './providerUtils';

export type StreamState = {
  messageId: string | null;
  model: string | null;
  contentIndex: number;
  currentBlockType: 'thinking' | 'text' | 'tool_use' | null;
  activeToolIndex: number | null;
  hasMessageStart: boolean;
  hasMessageStop: boolean;
  toolCalls: Record<number, ToolCallState>;
};

export type ResponsesFunctionCallState = {
  outputIndex: number;
  callId: string;
  itemId: string;
  name: string;
  extraContent?: unknown;
  argumentsBuffer: string;
  finalArguments: string;
  emitted: boolean;
  metadataEmitted: boolean;
};

export type ResponsesStreamContext = {
  functionCallByOutputIndex: Map<number, ResponsesFunctionCallState>;
  functionCallByCallId: Map<string, ResponsesFunctionCallState>;
  functionCallByItemId: Map<string, ResponsesFunctionCallState>;
  nextToolIndex: number;
  hasAnyDelta: boolean;
};

export function createStreamState(): StreamState {
  return {
    messageId: null,
    model: null,
    contentIndex: 0,
    currentBlockType: null,
    activeToolIndex: null,
    hasMessageStart: false,
    hasMessageStop: false,
    toolCalls: {},
  };
}

export function createResponsesStreamContext(): ResponsesStreamContext {
  return {
    functionCallByOutputIndex: new Map<number, ResponsesFunctionCallState>(),
    functionCallByCallId: new Map<string, ResponsesFunctionCallState>(),
    functionCallByItemId: new Map<string, ResponsesFunctionCallState>(),
    nextToolIndex: 0,
    hasAnyDelta: false,
  };
}

export function resolveResponsesObject(body: unknown): Record<string, unknown> {
  const source = toOptionalObject(body);
  if (!source) {
    return {};
  }
  const nested = toOptionalObject(source.response);
  if (nested) {
    return nested;
  }
  return source;
}

export function extractResponsesReasoningText(itemObj: Record<string, unknown>): string {
  const summaryTexts: string[] = [];
  for (const summaryItem of toArray(itemObj.summary)) {
    const summaryObj = toOptionalObject(summaryItem);
    if (!summaryObj) {
      continue;
    }
    const summaryText = toString(summaryObj.text);
    if (summaryText) {
      summaryTexts.push(summaryText);
    }
  }
  if (summaryTexts.length > 0) {
    return summaryTexts.join('');
  }

  const directText = toString(itemObj.text);
  if (directText) {
    return directText;
  }
  return '';
}

export function detectResponsesFinishReason(responseObj: Record<string, unknown>): string {
  const output = toArray(responseObj.output);
  const hasFunctionCall = output.some((item) => toString(toOptionalObject(item)?.type) === 'function_call');
  if (hasFunctionCall) {
    return 'tool_calls';
  }

  const status = toString(responseObj.status);
  const incompleteReason = toString(toOptionalObject(responseObj.incomplete_details)?.reason);
  if (
    status === 'incomplete'
    && (incompleteReason === 'max_output_tokens' || incompleteReason === 'max_tokens')
  ) {
    return 'length';
  }
  return 'stop';
}

export function emitSSE(res: http.ServerResponse, event: string, data: Record<string, unknown>): void {
  res.write(formatSSEEvent(event, data));
}

export function closeCurrentBlockIfNeeded(res: http.ServerResponse, state: StreamState): void {
  if (!state.currentBlockType) {
    return;
  }

  emitSSE(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: state.contentIndex,
  });

  state.contentIndex += 1;
  state.currentBlockType = null;
  state.activeToolIndex = null;
}

export function ensureMessageStart(
  res: http.ServerResponse,
  state: StreamState,
  chunk: OpenAIStreamChunk
): void {
  if (state.hasMessageStart) {
    return;
  }

  state.messageId = chunk.id ?? state.messageId ?? `chatcmpl-${Date.now()}`;
  state.model = chunk.model ?? state.model ?? 'unknown';

  emitSSE(res, 'message_start', {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      model: state.model,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  });

  state.hasMessageStart = true;
}

export function ensureThinkingBlock(res: http.ServerResponse, state: StreamState): void {
  if (state.currentBlockType === 'thinking') {
    return;
  }

  closeCurrentBlockIfNeeded(res, state);

  emitSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: {
      type: 'thinking',
      thinking: '',
    },
  });

  state.currentBlockType = 'thinking';
}

export function ensureTextBlock(res: http.ServerResponse, state: StreamState): void {
  if (state.currentBlockType === 'text') {
    return;
  }

  closeCurrentBlockIfNeeded(res, state);

  emitSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: {
      type: 'text',
      text: '',
    },
  });

  state.currentBlockType = 'text';
}

export function ensureToolUseBlock(
  res: http.ServerResponse,
  state: StreamState,
  index: number,
  toolCall: ToolCallState
): void {
  const resolvedId = toolCall.id || `tool_call_${index}`;
  const resolvedName = toolCall.name || 'tool';

  if (state.currentBlockType === 'tool_use' && state.activeToolIndex === index) {
    return;
  }

  closeCurrentBlockIfNeeded(res, state);

  const contentBlock: Record<string, unknown> = {
    type: 'tool_use',
    id: resolvedId,
    name: resolvedName,
  };

  if (toolCall.extraContent !== undefined) {
    contentBlock.extra_content = toolCall.extraContent;
  }

  emitSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: contentBlock,
  });

  state.currentBlockType = 'tool_use';
  state.activeToolIndex = index;
}

export function emitMessageDelta(
  res: http.ServerResponse,
  state: StreamState,
  finishReason: string | null | undefined,
  chunk: OpenAIStreamChunk
): void {
  closeCurrentBlockIfNeeded(res, state);

  emitSSE(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: mapStopReason(finishReason),
      stop_sequence: null,
    },
    usage: {
      input_tokens: chunk.usage?.prompt_tokens ?? 0,
      output_tokens: chunk.usage?.completion_tokens ?? 0,
    },
  });
}

export function processOpenAIChunk(
  res: http.ServerResponse,
  state: StreamState,
  chunk: OpenAIStreamChunk
): void {
  ensureMessageStart(res, state, chunk);

  const choice = chunk.choices?.[0];
  if (!choice) {
    return;
  }

  const delta = choice.delta;
  const deltaReasoning = delta?.reasoning_content ?? delta?.reasoning;

  if (deltaReasoning) {
    ensureThinkingBlock(res, state);
    emitSSE(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: state.contentIndex,
      delta: {
        type: 'thinking_delta',
        thinking: deltaReasoning,
      },
    });
  }

  if (delta?.content) {
    ensureTextBlock(res, state);
    emitSSE(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: state.contentIndex,
      delta: {
        type: 'text_delta',
        text: delta.content,
      },
    });
  }

  if (Array.isArray(delta?.tool_calls)) {
    for (const item of delta.tool_calls) {
      const toolIndex = item.index ?? 0;
      const existing = state.toolCalls[toolIndex] ?? {};
      const normalizedExtraContent = normalizeToolCallExtraContent(
        item as unknown as Record<string, unknown>
      );
      if (normalizedExtraContent !== undefined) {
        existing.extraContent = normalizedExtraContent;
      }

      if (item.id) {
        existing.id = item.id;
      }
      if (item.function?.name) {
        existing.name = item.function.name;
      }
      state.toolCalls[toolIndex] = existing;
      if (existing.id && existing.extraContent !== undefined) {
        cacheToolCallExtraContent(existing.id, existing.extraContent);
      }

      if (item.function?.name) {
        ensureToolUseBlock(res, state, toolIndex, existing);
      }

      if (item.function?.arguments) {
        ensureToolUseBlock(res, state, toolIndex, existing);
        emitSSE(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.contentIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: item.function.arguments,
          },
        });
      }
    }
  }

  if (choice.finish_reason) {
    emitMessageDelta(res, state, choice.finish_reason, chunk);
  }
}

export function parseSSEPacket(packet: string): { event: string; payload: string } {
  const lines = packet.split(/\r?\n/);
  const dataLines: string[] = [];
  let event = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    event,
    payload: dataLines.join('\n'),
  };
}

export function findSSEPacketBoundary(
  buffer: string
): { index: number; separatorLength: number } | null {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match || typeof match.index !== 'number') {
    return null;
  }

  return {
    index: match.index,
    separatorLength: match[0].length,
  };
}

export function extractResponsesFunctionCallMetadata(
  payloadObj: Record<string, unknown>,
  itemObj: Record<string, unknown> | null
): {
  outputIndex: number | null;
  callId: string;
  itemId: string;
  name: string;
  extraContent: unknown;
} {
  const outputIndex = toNumber(payloadObj.output_index) ?? toNumber(itemObj?.output_index);
  const callId = toString(payloadObj.call_id) || toString(itemObj?.call_id);
  const itemId = toString(payloadObj.item_id) || toString(itemObj?.id);
  const name = toString(payloadObj.name) || toString(itemObj?.name);
  const extraContent = itemObj ? normalizeToolCallExtraContent(itemObj) : undefined;
  return {
    outputIndex,
    callId,
    itemId,
    name,
    extraContent,
  };
}

export function registerResponsesFunctionCallState(
  context: ResponsesStreamContext,
  payloadObj: Record<string, unknown>,
  itemObj: Record<string, unknown> | null
): ResponsesFunctionCallState {
  const metadata = extractResponsesFunctionCallMetadata(payloadObj, itemObj);

  let callState = metadata.callId
    ? context.functionCallByCallId.get(metadata.callId)
    : undefined;
  if (!callState && metadata.itemId) {
    callState = context.functionCallByItemId.get(metadata.itemId);
  }
  if (!callState && metadata.outputIndex !== null) {
    callState = context.functionCallByOutputIndex.get(metadata.outputIndex);
  }

  if (!callState) {
    const outputIndex = metadata.outputIndex !== null
      ? metadata.outputIndex
      : context.nextToolIndex;
    callState = {
      outputIndex,
      callId: '',
      itemId: '',
      name: '',
      extraContent: undefined,
      argumentsBuffer: '',
      finalArguments: '',
      emitted: false,
      metadataEmitted: false,
    };
    context.functionCallByOutputIndex.set(outputIndex, callState);
    context.nextToolIndex = Math.max(context.nextToolIndex, outputIndex + 1);
  } else if (metadata.outputIndex !== null && callState.outputIndex !== metadata.outputIndex) {
    context.functionCallByOutputIndex.delete(callState.outputIndex);
    callState.outputIndex = metadata.outputIndex;
    context.functionCallByOutputIndex.set(callState.outputIndex, callState);
    context.nextToolIndex = Math.max(context.nextToolIndex, callState.outputIndex + 1);
  } else {
    context.nextToolIndex = Math.max(context.nextToolIndex, callState.outputIndex + 1);
  }

  if (metadata.callId) {
    callState.callId = metadata.callId;
    context.functionCallByCallId.set(metadata.callId, callState);
  }
  if (metadata.itemId) {
    callState.itemId = metadata.itemId;
    context.functionCallByItemId.set(metadata.itemId, callState);
  }
  if (metadata.name) {
    callState.name = metadata.name;
  }
  if (metadata.extraContent !== undefined) {
    callState.extraContent = metadata.extraContent;
  }

  context.functionCallByOutputIndex.set(callState.outputIndex, callState);
  return callState;
}

export function syncToolCallStateWithResponsesFunctionCall(
  state: StreamState,
  callState: ResponsesFunctionCallState
): ToolCallState {
  const toolCall = state.toolCalls[callState.outputIndex] ?? {};
  if (callState.callId) {
    toolCall.id = callState.callId;
  } else if (callState.itemId) {
    toolCall.id = callState.itemId;
  } else if (!toolCall.id) {
    toolCall.id = `tool_call_${callState.outputIndex}`;
  }
  if (callState.name) {
    toolCall.name = callState.name;
  }
  if (callState.extraContent !== undefined) {
    toolCall.extraContent = callState.extraContent;
  }
  state.toolCalls[callState.outputIndex] = toolCall;
  if (toolCall.id && toolCall.extraContent !== undefined) {
    cacheToolCallExtraContent(toolCall.id, toolCall.extraContent);
  }
  return toolCall;
}

export function emitResponsesFunctionCallChunk(
  res: http.ServerResponse,
  state: StreamState,
  callState: ResponsesFunctionCallState,
  options: {
    includeName: boolean;
    argumentsText?: string;
    responseId?: string;
    model?: string;
  }
): void {
  const toolCall = syncToolCallStateWithResponsesFunctionCall(state, callState);

  const functionObj: Record<string, unknown> = {};
  if (options.includeName && toolCall.name) {
    functionObj.name = toolCall.name;
  }

  const argumentsText = options.argumentsText ?? '';
  if (argumentsText) {
    functionObj.arguments = argumentsText;
  }

  if (Object.keys(functionObj).length === 0) {
    return;
  }

  processOpenAIChunk(res, state, {
    id: options.responseId || undefined,
    model: options.model || undefined,
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: callState.outputIndex,
              id: toolCall.id,
              type: 'function',
              function: functionObj,
            },
          ],
        },
      },
    ],
  });
}

export function emitResponsesFunctionCallMetadataOnce(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  callState: ResponsesFunctionCallState,
  responseId?: string,
  model?: string
): void {
  if (callState.metadataEmitted) {
    return;
  }
  if (!callState.name) {
    return;
  }

  emitResponsesFunctionCallChunk(res, state, callState, {
    includeName: true,
    responseId,
    model,
  });
  callState.metadataEmitted = true;
  context.hasAnyDelta = true;
}

export function emitResponsesFunctionCallArgumentsOnce(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  callState: ResponsesFunctionCallState,
  argumentsText: string,
  responseId?: string,
  model?: string
): void {
  if (callState.emitted) {
    return;
  }

  const resolvedArguments = argumentsText
    || callState.finalArguments
    || callState.argumentsBuffer
    || '{}';
  if (!resolvedArguments) {
    return;
  }

  callState.finalArguments = resolvedArguments;
  emitResponsesFunctionCallChunk(res, state, callState, {
    includeName: true,
    argumentsText: resolvedArguments,
    responseId,
    model,
  });
  callState.emitted = true;
  callState.metadataEmitted = true;
  context.hasAnyDelta = true;
}

export function emitResponsesCompletedFunctionCalls(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  responseObj: Record<string, unknown>
): void {
  const responseId = toString(responseObj.id);
  const model = toString(responseObj.model);

  for (const [index, item] of toArray(responseObj.output).entries()) {
    const itemObj = toOptionalObject(item);
    if (!itemObj || toString(itemObj.type) !== 'function_call') {
      continue;
    }

    const payloadObj: Record<string, unknown> = {
      response_id: responseId,
      model,
      call_id: toString(itemObj.call_id),
      item_id: toString(itemObj.id),
      name: toString(itemObj.name),
    };
    const itemOutputIndex = toNumber(itemObj.output_index);
    if (itemOutputIndex !== null) {
      payloadObj.output_index = itemOutputIndex;
    } else {
      payloadObj.output_index = index;
    }

    const callState = registerResponsesFunctionCallState(context, payloadObj, itemObj);
    emitResponsesFunctionCallMetadataOnce(
      res,
      state,
      context,
      callState,
      responseId,
      model
    );

    const finalizedArguments = normalizeFunctionArguments(itemObj.arguments)
      || callState.finalArguments
      || callState.argumentsBuffer
      || '{}';
    emitResponsesFunctionCallArgumentsOnce(
      res,
      state,
      context,
      callState,
      finalizedArguments,
      responseId,
      model
    );
  }
}

export function emitResponsesFallbackContent(
  res: http.ServerResponse,
  state: StreamState,
  responseObj: Record<string, unknown>,
  context: ResponsesStreamContext
): void {
  const syntheticOpenAIResponse = convertResponsesToOpenAIResponse(responseObj);
  const firstChoice = toOptionalObject(toArray(syntheticOpenAIResponse.choices)[0]);
  const message = toOptionalObject(firstChoice?.message);
  if (!message) {
    return;
  }

  const reasoning = toString(message.reasoning_content) || toString(message.reasoning);
  if (reasoning) {
    processOpenAIChunk(res, state, {
      id: toString(syntheticOpenAIResponse.id),
      model: toString(syntheticOpenAIResponse.model),
      choices: [{ delta: { reasoning } }],
    });
  }

  const messageContent = message.content;
  if (typeof messageContent === 'string' && messageContent) {
    processOpenAIChunk(res, state, {
      id: toString(syntheticOpenAIResponse.id),
      model: toString(syntheticOpenAIResponse.model),
      choices: [{ delta: { content: messageContent } }],
    });
  } else if (Array.isArray(messageContent)) {
    for (const part of messageContent) {
      const partObj = toOptionalObject(part);
      const text = toString(partObj?.text);
      if (text) {
        processOpenAIChunk(res, state, {
          id: toString(syntheticOpenAIResponse.id),
          model: toString(syntheticOpenAIResponse.model),
          choices: [{ delta: { content: text } }],
        });
      }
    }
  }

  for (const toolCall of toArray(message.tool_calls)) {
    const toolCallObj = toOptionalObject(toolCall);
    const functionObj = toOptionalObject(toolCallObj?.function);
    if (!toolCallObj || !functionObj) {
      continue;
    }

    const payloadObj: Record<string, unknown> = {
      response_id: toString(syntheticOpenAIResponse.id),
      model: toString(syntheticOpenAIResponse.model),
      call_id: toString(toolCallObj.id),
      name: toString(functionObj.name),
    };
    const callState = registerResponsesFunctionCallState(context, payloadObj, null);
    emitResponsesFunctionCallMetadataOnce(
      res,
      state,
      context,
      callState,
      toString(syntheticOpenAIResponse.id),
      toString(syntheticOpenAIResponse.model)
    );
    emitResponsesFunctionCallArgumentsOnce(
      res,
      state,
      context,
      callState,
      toString(functionObj.arguments) || '{}',
      toString(syntheticOpenAIResponse.id),
      toString(syntheticOpenAIResponse.model)
    );
  }
}

export function processResponsesStreamEvent(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  event: string,
  payloadObj: Record<string, unknown>
): void {
  const eventType = event || toString(payloadObj.type);

  const responseObjFromPayload = toOptionalObject(payloadObj.response);
  if (responseObjFromPayload) {
    processOpenAIChunk(res, state, {
      id: toString(responseObjFromPayload.id),
      model: toString(responseObjFromPayload.model),
      choices: [],
    });
  }

  if (eventType === 'response.created') {
    return;
  }

  if (eventType === 'response.output_text.delta' || eventType === 'response.output.delta') {
    const textDelta = toString(payloadObj.delta);
    if (textDelta) {
      processOpenAIChunk(res, state, {
        id: toString(payloadObj.response_id),
        model: toString(payloadObj.model),
        choices: [{ delta: { content: textDelta } }],
      });
      context.hasAnyDelta = true;
    }
    return;
  }

  if (
    eventType === 'response.reasoning_summary_text.delta'
    || eventType === 'response.reasoning.delta'
  ) {
    const thinkingDelta = toString(payloadObj.delta);
    if (thinkingDelta) {
      processOpenAIChunk(res, state, {
        id: toString(payloadObj.response_id),
        model: toString(payloadObj.model),
        choices: [{ delta: { reasoning: thinkingDelta } }],
      });
      context.hasAnyDelta = true;
    }
    return;
  }

  if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
    const itemObj = toOptionalObject(payloadObj.item);
    if (!itemObj) {
      return;
    }

    if (toString(itemObj.type) === 'function_call') {
      const callState = registerResponsesFunctionCallState(context, payloadObj, itemObj);
      const responseId = toString(payloadObj.response_id);
      const model = toString(payloadObj.model);
      emitResponsesFunctionCallMetadataOnce(
        res,
        state,
        context,
        callState,
        responseId,
        model
      );

      if (eventType === 'response.output_item.done' && !callState.emitted) {
        const inlineArguments = normalizeFunctionArguments(itemObj.arguments);
        if (inlineArguments) {
          emitResponsesFunctionCallArgumentsOnce(
            res,
            state,
            context,
            callState,
            inlineArguments,
            responseId,
            model
          );
        }
      }
    }
    return;
  }

  if (eventType === 'response.function_call_arguments.delta') {
    const callState = registerResponsesFunctionCallState(context, payloadObj, null);
    const argumentsDelta = normalizeFunctionArguments(payloadObj.delta);
    if (!argumentsDelta) {
      return;
    }
    callState.argumentsBuffer += argumentsDelta;
    return;
  }

  if (eventType === 'response.function_call_arguments.done') {
    const callState = registerResponsesFunctionCallState(context, payloadObj, null);
    const argumentsDone = normalizeFunctionArguments(payloadObj.arguments)
      || callState.argumentsBuffer
      || '{}';
    callState.finalArguments = argumentsDone;
    emitResponsesFunctionCallArgumentsOnce(
      res,
      state,
      context,
      callState,
      argumentsDone,
      toString(payloadObj.response_id),
      toString(payloadObj.model)
    );
    return;
  }

  if (eventType === 'response.completed') {
    const responseObj = resolveResponsesObject(payloadObj);
    if (!context.hasAnyDelta) {
      emitResponsesFallbackContent(res, state, responseObj, context);
    }
    emitResponsesCompletedFunctionCalls(res, state, context, responseObj);

    const usage = toOptionalObject(responseObj.usage);
    processOpenAIChunk(res, state, {
      id: toString(responseObj.id),
      model: toString(responseObj.model),
      choices: [{ finish_reason: detectResponsesFinishReason(responseObj) }],
      usage: {
        prompt_tokens: toNumber(usage?.input_tokens) ?? toNumber(usage?.prompt_tokens) ?? 0,
        completion_tokens: toNumber(usage?.output_tokens) ?? toNumber(usage?.completion_tokens) ?? 0,
      },
    });
  }
}

// Helper to convert Responses to OpenAI format (needed for fallback content)
export function convertResponsesToOpenAIResponse(body: unknown): Record<string, unknown> {
  const responseObj = resolveResponsesObject(body);
  const output = toArray(responseObj.output);

  const textParts: Array<{ type: 'text'; text: string }> = [];
  const reasoningParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const item of output) {
    const itemObj = toOptionalObject(item);
    if (!itemObj) {
      continue;
    }

    const itemType = toString(itemObj.type);
    if (itemType === 'message') {
      for (const contentItem of toArray(itemObj.content)) {
        const contentObj = toOptionalObject(contentItem);
        if (!contentObj) {
          continue;
        }
        const contentType = toString(contentObj.type);
        if (contentType === 'output_text' || contentType === 'text' || contentType === 'input_text') {
          const text = toString(contentObj.text);
          if (text) {
            textParts.push({ type: 'text', text });
          }
        }
      }
      continue;
    }

    if (itemType === 'reasoning') {
      const reasoningText = extractResponsesReasoningText(itemObj);
      if (reasoningText) {
        reasoningParts.push(reasoningText);
      }
      continue;
    }

    if (itemType === 'function_call') {
      const callId = toString(itemObj.call_id) || toString(itemObj.id);
      const name = toString(itemObj.name);
      if (!callId || !name) {
        continue;
      }
      const toolCall: Record<string, unknown> = {
        id: callId,
        type: 'function',
        function: {
          name,
          arguments: normalizeFunctionArguments(itemObj.arguments) || '{}',
        },
      };
      const extraContent = normalizeToolCallExtraContent(itemObj);
      if (extraContent !== undefined) {
        toolCall.extra_content = extraContent;
      }
      toolCalls.push(toolCall);
    }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
  };
  if (textParts.length === 1 && textParts[0].type === 'text') {
    message.content = textParts[0].text;
  } else if (textParts.length > 1) {
    message.content = textParts;
  } else {
    message.content = null;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  if (reasoningParts.length > 0) {
    message.reasoning_content = reasoningParts.join('');
  }

  const usage = toOptionalObject(responseObj.usage);
  return {
    id: toString(responseObj.id),
    model: toString(responseObj.model),
    choices: [
      {
        message,
        finish_reason: detectResponsesFinishReason(responseObj),
      },
    ],
    usage: {
      prompt_tokens: toNumber(usage?.input_tokens) ?? toNumber(usage?.prompt_tokens) ?? 0,
      completion_tokens: toNumber(usage?.output_tokens) ?? toNumber(usage?.completion_tokens) ?? 0,
    },
  };
}

export async function handleResponsesStreamResponse(
  upstreamResponse: Response,
  res: http.ServerResponse
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (!upstreamResponse.body) {
    emitSSE(res, 'error', createAnthropicErrorBody('Upstream returned empty stream', 'stream_error'));
    res.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const state = createStreamState();
  const context = createResponsesStreamContext();

  let buffer = '';
  let sawDoneMarker = false;

  const flushDone = () => {
    if (!state.hasMessageStart) {
      return;
    }
    if (!state.hasMessageStop) {
      closeCurrentBlockIfNeeded(res, state);
      emitSSE(res, 'message_stop', {
        type: 'message_stop',
      });
      state.hasMessageStop = true;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundary = findSSEPacketBoundary(buffer);
    while (boundary) {
      const packet = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.separatorLength);

      const parsedPacket = parseSSEPacket(packet);
      const payload = parsedPacket.payload;
      if (!payload) {
        boundary = findSSEPacketBoundary(buffer);
        continue;
      }

      if (payload === '[DONE]') {
        flushDone();
        sawDoneMarker = true;
        break;
      }

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        processResponsesStreamEvent(res, state, context, parsedPacket.event, parsed);
      } catch {
        // Ignore malformed stream chunks.
      }

      boundary = findSSEPacketBoundary(buffer);
    }

    if (sawDoneMarker) {
      break;
    }
  }

  if (sawDoneMarker) {
    try {
      await reader.cancel();
    } catch {
      // noop
    }
  }

  flushDone();
  res.end();
}

export async function handleChatCompletionsStreamResponse(
  upstreamResponse: Response,
  res: http.ServerResponse
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (!upstreamResponse.body) {
    console.warn('[CoworkProxy] Stream: upstream returned empty body');
    emitSSE(res, 'error', createAnthropicErrorBody('Upstream returned empty stream', 'stream_error'));
    res.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const state = createStreamState();

  let buffer = '';
  let sawDoneMarker = false;
  let chunkCount = 0;

  const flushDone = () => {
    if (!state.hasMessageStart) {
      console.warn('[CoworkProxy] Stream: flushDone called but no message_start was emitted');
      return;
    }
    if (!state.hasMessageStop) {
      closeCurrentBlockIfNeeded(res, state);
      emitSSE(res, 'message_stop', {
        type: 'message_stop',
      });
      state.hasMessageStop = true;
    }
  };

  console.log('[CoworkProxy] Stream: starting to read upstream SSE chunks');

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      console.log(`[CoworkProxy] Stream: upstream done after ${chunkCount} chunks, sawDoneMarker=${sawDoneMarker}`);
      break;
    }

    chunkCount++;
    buffer += decoder.decode(value, { stream: true });

    let boundary = findSSEPacketBoundary(buffer);
    while (boundary) {
      const packet = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.separatorLength);

      const lines = packet.split(/\r?\n/);
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      const payload = dataLines.join('\n');
      if (!payload) {
        boundary = findSSEPacketBoundary(buffer);
        continue;
      }

      if (payload === '[DONE]') {
        flushDone();
        sawDoneMarker = true;
        break;
      }

      try {
        const parsed = JSON.parse(payload) as OpenAIStreamChunk;
        processOpenAIChunk(res, state, parsed);
      } catch {
        // Ignore malformed stream chunks.
      }

      boundary = findSSEPacketBoundary(buffer);
    }

    if (sawDoneMarker) {
      break;
    }
  }

  if (sawDoneMarker) {
    try {
      await reader.cancel();
    } catch {
      // noop
    }
  }

  flushDone();
  res.end();
}

// Import for createAnthropicErrorBody used in error handling
import { createAnthropicErrorBody } from './providerUtils';
