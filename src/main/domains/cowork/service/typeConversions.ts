export type ToolCallState = {
  id?: string;
  name?: string;
  extraContent?: unknown;
};

export function toOptionalObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

export function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

export function normalizeFunctionArguments(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export function normalizeScheduledTaskWorkingDirectory(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';

  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  // Sandbox guest workspace roots are not valid host directories.
  if (/^(?:[A-Za-z]:)?\/workspace(?:\/project)?$/i.test(normalized)) {
    return '';
  }
  return raw;
}

export function normalizeToolCallExtraContent(toolCallObj: Record<string, unknown>): unknown {
  if (toolCallObj.extra_content !== undefined) {
    return toolCallObj.extra_content;
  }

  const functionObj = toOptionalObject(toolCallObj.function);
  if (functionObj?.extra_content !== undefined) {
    return functionObj.extra_content;
  }

  const thoughtSignature = toString(functionObj?.thought_signature);
  if (!thoughtSignature) {
    return undefined;
  }

  return {
    google: {
      thought_signature: thoughtSignature,
    },
  };
}

export function extractTextFromChatContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  const chunks: string[] = [];
  for (const part of toArray(content)) {
    const partObj = toOptionalObject(part);
    if (!partObj) {
      continue;
    }
    const partText = toString(partObj.text);
    if (partText) {
      chunks.push(partText);
    }
  }
  return chunks.join('');
}

export function extractErrorMessage(raw: string): string {
  if (!raw) {
    return 'Upstream API request failed';
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const errorObj = parsed.error;
    if (errorObj && typeof errorObj === 'object' && !Array.isArray(errorObj)) {
      const message = (errorObj as Record<string, unknown>).message;
      if (typeof message === 'string' && message) {
        return message;
      }
    }
    if (typeof parsed.message === 'string' && parsed.message) {
      return parsed.message;
    }
  } catch {
    // noop
  }

  return raw;
}

function shouldUseMaxCompletionTokensForModel(model: unknown): boolean {
  if (typeof model !== 'string') {
    return false;
  }
  const normalizedModel = model.toLowerCase();
  const resolvedModel = normalizedModel.includes('/')
    ? normalizedModel.slice(normalizedModel.lastIndexOf('/') + 1)
    : normalizedModel;
  return resolvedModel.startsWith('gpt-5')
    || resolvedModel.startsWith('o1')
    || resolvedModel.startsWith('o3')
    || resolvedModel.startsWith('o4');
}

export function normalizeMaxTokensFieldForOpenAIProvider(
  openAIRequest: Record<string, unknown>,
  provider?: string
): void {
  if (provider !== 'openai') {
    return;
  }
  if (!shouldUseMaxCompletionTokensForModel(openAIRequest.model)) {
    return;
  }
  const maxTokens = openAIRequest.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) {
    return;
  }
  openAIRequest.max_completion_tokens = maxTokens;
  delete openAIRequest.max_tokens;
}
