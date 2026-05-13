import { buildOpenAIChatCompletionsURL } from './coworkFormatTransform';
import {
  toOptionalObject,
  toString,
  toArray,
  toNumber,
  normalizeToolCallExtraContent,
  normalizeFunctionArguments,
  stringifyUnknown,
  extractTextFromChatContent,
} from './typeConversions';

export type UpstreamAPIType = 'chat_completions' | 'responses';

export function buildOpenAIResponsesURL(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/responses';
  }
  if (normalized.endsWith('/responses')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/responses`;
  }
  return `${normalized}/v1/responses`;
}

export function buildUpstreamTargetUrls(baseURL: string, apiType: UpstreamAPIType): string[] {
  if (apiType === 'responses') {
    return [buildOpenAIResponsesURL(baseURL)];
  }

  const primary = buildOpenAIChatCompletionsURL(baseURL);
  const urls = new Set<string>([primary]);

  if (primary.includes('generativelanguage.googleapis.com')) {
    if (primary.includes('/v1beta/openai/')) {
      urls.add(primary.replace('/v1beta/openai/', '/v1/openai/'));
    } else if (primary.includes('/v1/openai/')) {
      urls.add(primary.replace('/v1/openai/', '/v1beta/openai/'));
    }
  }

  return Array.from(urls);
}

export function convertUserChatContentToResponsesInput(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content
      ? [{ type: 'input_text', text: content }]
      : [];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const item of toArray(content)) {
    const itemObj = toOptionalObject(item);
    if (!itemObj) {
      continue;
    }

    const itemType = toString(itemObj.type);
    if (itemType === 'text') {
      const text = toString(itemObj.text);
      if (text) {
        parts.push({ type: 'input_text', text });
      }
      continue;
    }

    if (itemType === 'image_url') {
      const imageURLObj = toOptionalObject(itemObj.image_url);
      const imageURL = toString(imageURLObj?.url) || toString(itemObj.image_url);
      if (imageURL) {
        parts.push({ type: 'input_image', image_url: imageURL });
      }
    }
  }

  return parts;
}

export function normalizeResponsesToolsFromChat(toolsInput: unknown): Array<Record<string, unknown>> {
  const normalizedTools: Array<Record<string, unknown>> = [];

  for (const tool of toArray(toolsInput)) {
    const toolObj = toOptionalObject(tool);
    if (!toolObj) {
      continue;
    }

    const toolType = toString(toolObj.type);
    if (toolType !== 'function') {
      normalizedTools.push(toolObj);
      continue;
    }

    const functionObj = toOptionalObject(toolObj.function);
    const name = toString(toolObj.name) || toString(functionObj?.name);
    if (!name) {
      continue;
    }

    const normalized: Record<string, unknown> = {
      type: 'function',
      name,
    };

    const description = toString(toolObj.description) || toString(functionObj?.description);
    if (description) {
      normalized.description = description;
    }

    const parameters = toolObj.parameters ?? functionObj?.parameters;
    if (parameters !== undefined) {
      normalized.parameters = parameters;
    }

    const strict = toolObj.strict ?? functionObj?.strict;
    if (typeof strict === 'boolean') {
      normalized.strict = strict;
    }

    normalizedTools.push(normalized);
  }

  return normalizedTools;
}

export function normalizeResponsesToolChoiceFromChat(toolChoice: unknown): unknown {
  if (typeof toolChoice === 'string') {
    return toolChoice;
  }

  const toolChoiceObj = toOptionalObject(toolChoice);
  if (!toolChoiceObj) {
    return toolChoice;
  }

  const normalizedType = toString(toolChoiceObj.type).toLowerCase();
  if (normalizedType === 'any') {
    return 'required';
  }
  if (normalizedType === 'auto' || normalizedType === 'none' || normalizedType === 'required') {
    return normalizedType;
  }
  if (normalizedType === 'function' || normalizedType === 'tool') {
    const functionObj = toOptionalObject(toolChoiceObj.function);
    const name = toString(toolChoiceObj.name) || toString(functionObj?.name);
    if (name) {
      return {
        type: 'function',
        name,
      };
    }
  }

  return toolChoice;
}

export function convertChatCompletionsRequestToResponsesRequest(
  chatRequest: Record<string, unknown>
): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  const input: Array<Record<string, unknown>> = [];
  const instructions: string[] = [];
  const unresolvedFunctionCalls = new Map<string, { name: string; hasOutput: boolean }>();

  if (chatRequest.model !== undefined) {
    request.model = chatRequest.model;
  }
  if (chatRequest.stream !== undefined) {
    request.stream = chatRequest.stream;
  }
  if (chatRequest.temperature !== undefined) {
    request.temperature = chatRequest.temperature;
  }
  if (chatRequest.top_p !== undefined) {
    request.top_p = chatRequest.top_p;
  }
  const normalizedTools = normalizeResponsesToolsFromChat(chatRequest.tools);
  if (normalizedTools.length > 0) {
    request.tools = normalizedTools;
  }
  if (chatRequest.tool_choice !== undefined) {
    request.tool_choice = normalizeResponsesToolChoiceFromChat(chatRequest.tool_choice);
  }

  const maxOutputTokens = toNumber(chatRequest.max_output_tokens)
    ?? toNumber(chatRequest.max_completion_tokens)
    ?? toNumber(chatRequest.max_tokens);
  if (maxOutputTokens !== null) {
    request.max_output_tokens = maxOutputTokens;
  }

  for (const message of toArray(chatRequest.messages)) {
    const messageObj = toOptionalObject(message);
    if (!messageObj) {
      continue;
    }

    const role = toString(messageObj.role);
    if (role === 'system') {
      const text = extractTextFromChatContent(messageObj.content);
      if (text) {
        instructions.push(text);
      }
      continue;
    }

    if (role === 'tool') {
      const toolCallId = toString(messageObj.tool_call_id);
      const output = stringifyUnknown(messageObj.content);
      if (toolCallId && output) {
        input.push({
          type: 'function_call_output',
          call_id: toolCallId,
          output,
        });
      }
      continue;
    }

    if (role === 'assistant') {
      const text = extractTextFromChatContent(messageObj.content);
      if (text) {
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }

      for (const toolCall of toArray(messageObj.tool_calls)) {
        const toolCallObj = toOptionalObject(toolCall);
        const functionObj = toOptionalObject(toolCallObj?.function);
        if (!toolCallObj || !functionObj) {
          continue;
        }
        const callId = toString(toolCallObj.call_id) || toString(toolCallObj.id);
        const name = toString(functionObj.name);
        const argumentsText = normalizeFunctionArguments(functionObj.arguments) || '{}';
        if (!callId || !name) {
          continue;
        }

        const functionCallItem: Record<string, unknown> = {
          type: 'function_call',
          call_id: callId,
          name,
          arguments: argumentsText,
        };
        const extraContent = normalizeToolCallExtraContent(toolCallObj);
        if (extraContent !== undefined) {
          functionCallItem.extra_content = extraContent;
        }
        input.push(functionCallItem);
        unresolvedFunctionCalls.set(callId, {
          name,
          hasOutput: false,
        });
      }
      continue;
    }

    const userParts = convertUserChatContentToResponsesInput(messageObj.content);
    if (userParts.length > 0) {
      input.push({
        role: role || 'user',
        content: userParts,
      });
    }
  }

  if (instructions.length > 0) {
    request.instructions = instructions.join('\n\n');
  }

  for (const messageItem of input) {
    if (toString(messageItem.type) !== 'function_call_output') {
      continue;
    }
    const callId = toString(messageItem.call_id);
    if (!callId) {
      continue;
    }
    const existing = unresolvedFunctionCalls.get(callId);
    if (existing) {
      existing.hasOutput = true;
      unresolvedFunctionCalls.set(callId, existing);
    }
  }

  for (const [callId, callInfo] of unresolvedFunctionCalls.entries()) {
    if (callInfo.hasOutput) {
      continue;
    }
    // OpenAI Responses requires each historical function_call to have a matching output.
    // When upstream tool execution fails before producing a tool_result, auto-close it here.
    input.push({
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({
        error: `Missing tool output for function call "${callId}" (${callInfo.name || 'unknown'}). Auto-closed by compatibility proxy.`,
      }),
    });
  }

  request.input = input;

  return request;
}

export function normalizeToolName(value: unknown): string {
  return toString(value).trim().toLowerCase();
}

export function filterOpenAIToolsForProvider(
  openAIRequest: Record<string, unknown>,
  provider?: string
): void {
  if (provider !== 'openai') {
    return;
  }

  const tools = toArray(openAIRequest.tools);
  if (tools.length === 0) {
    return;
  }

  const filteredTools = tools.filter((tool) => {
    const toolObj = toOptionalObject(tool);
    if (!toolObj) return true;
    const functionObj = toOptionalObject(toolObj.function);
    const toolName = normalizeToolName(toolObj.name) || normalizeToolName(functionObj?.name);
    if (!toolName) return true;
    // OpenAI path should use skills by reading SKILL.md via normal tools, not Skill tool.
    return toolName !== 'skill';
  });

  if (filteredTools.length !== tools.length) {
    openAIRequest.tools = filteredTools;
    const toolChoiceObj = toOptionalObject(openAIRequest.tool_choice);
    if (toolChoiceObj) {
      const forcedName = normalizeToolName(toolChoiceObj.name)
        || normalizeToolName(toOptionalObject(toolChoiceObj.function)?.name);
      if (forcedName === 'skill') {
        openAIRequest.tool_choice = 'auto';
      }
    }
  }
}

/**
 * MiniMax API only accepts 'system', 'user', and 'assistant' roles.
 * OpenAI's newer API uses 'developer' role which MiniMax doesn't recognize.
 * This function remaps 'developer' to 'system' for MiniMax compatibility.
 */
export function remapMessageRolesForMiniMax(
  openAIRequest: Record<string, unknown>,
  provider?: string
): void {
  if (provider !== 'minimax') {
    return;
  }

  const messages = toArray(openAIRequest.messages);
  if (messages.length === 0) {
    return;
  }

  for (const message of messages) {
    const messageObj = toOptionalObject(message);
    if (!messageObj) {
      continue;
    }

    const role = toString(messageObj.role);
    if (role === 'developer') {
      messageObj.role = 'system';
    }
  }
}

export function convertMaxTokensToMaxCompletionTokens(
  openAIRequest: Record<string, unknown>
): { changed: boolean; convertedTo?: number } {
  const maxTokens = openAIRequest.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) {
    return { changed: false };
  }
  openAIRequest.max_completion_tokens = maxTokens;
  delete openAIRequest.max_tokens;
  return { changed: true, convertedTo: maxTokens };
}

/**
 * Strip tools and tool_choice from an OpenAI-format request.
 * Returns true if tools were actually removed.
 */
export function stripToolsFromRequest(openAIRequest: Record<string, unknown>): boolean {
  const tools = openAIRequest.tools;
  if (!tools || (Array.isArray(tools) && tools.length === 0)) {
    return false;
  }
  delete openAIRequest.tools;
  delete openAIRequest.tool_choice;
  return true;
}
