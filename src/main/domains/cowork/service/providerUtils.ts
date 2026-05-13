import http from 'http';
import {
  toOptionalObject,
  toString,
  toArray,
  toNumber,
  normalizeToolCallExtraContent,
  ToolCallState,
} from './typeConversions';
import type { UpstreamAPIType } from './requestTransform';

export const GEMINI_FALLBACK_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

const MAX_TOOL_CALL_EXTRA_CONTENT_CACHE = 1024;
const toolCallExtraContentById = new Map<string, unknown>();

export { toolCallExtraContentById, MAX_TOOL_CALL_EXTRA_CONTENT_CACHE };

export function resolveUpstreamAPIType(provider?: string): UpstreamAPIType {
  return provider?.toLowerCase() === 'openai' ? 'responses' : 'chat_completions';
}

export function extractMaxTokensRange(errorMessage: string): { min: number; max: number } | null {
  if (!errorMessage) {
    return null;
  }

  const normalized = errorMessage.toLowerCase();
  if (!normalized.includes('max_tokens')) {
    return null;
  }

  const bracketMatch = /max_tokens[^\[]*\[\s*(\d+)\s*,\s*(\d+)\s*\]/i.exec(errorMessage);
  if (bracketMatch) {
    return {
      min: Number(bracketMatch[1]),
      max: Number(bracketMatch[2]),
    };
  }

  const betweenMatch = /max_tokens.*between\s+(\d+)\s*(?:and|-)\s*(\d+)/i.exec(errorMessage);
  if (betweenMatch) {
    return {
      min: Number(betweenMatch[1]),
      max: Number(betweenMatch[2]),
    };
  }

  return null;
}

export function clampMaxTokensFromError(
  openAIRequest: Record<string, unknown>,
  errorMessage: string
): { changed: boolean; clampedTo?: number } {
  const currentMaxTokens = openAIRequest.max_tokens;
  if (typeof currentMaxTokens !== 'number' || !Number.isFinite(currentMaxTokens)) {
    return { changed: false };
  }

  const range = extractMaxTokensRange(errorMessage);
  if (!range) {
    return { changed: false };
  }

  const normalizedMin = Math.max(1, Math.floor(range.min));
  const normalizedMax = Math.max(normalizedMin, Math.floor(range.max));
  const nextValue = Math.min(Math.max(Math.floor(currentMaxTokens), normalizedMin), normalizedMax);

  if (nextValue === currentMaxTokens) {
    return { changed: false };
  }

  openAIRequest.max_tokens = nextValue;
  return { changed: true, clampedTo: nextValue };
}

export function shouldUseMaxCompletionTokensForModel(model: unknown): boolean {
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

/**
 * Merge multiple system messages into a single one at the beginning.
 * Some OpenAI-compatible providers (e.g. MiniMax) reject requests containing
 * more than one system message, returning error 2013 "invalid chat setting".
 * This is safe for all providers since the semantic meaning is preserved.
 */
export function mergeSystemMessagesForProvider(
  openAIRequest: Record<string, unknown>
): void {
  const messages = toArray(openAIRequest.messages);
  if (messages.length === 0) {
    return;
  }

  const systemTexts: string[] = [];
  const nonSystemMessages: unknown[] = [];
  for (const msg of messages) {
    const msgObj = toOptionalObject(msg);
    if (!msgObj) {
      nonSystemMessages.push(msg);
      continue;
    }
    if (toString(msgObj.role) === 'system') {
      const text = typeof msgObj.content === 'string' ? msgObj.content : '';
      if (text) {
        systemTexts.push(text);
      }
    } else {
      nonSystemMessages.push(msg);
    }
  }

  // Only rewrite if there are 2+ system messages; otherwise leave as-is
  if (systemTexts.length <= 1) {
    return;
  }

  const merged: unknown[] = [];
  merged.push({ role: 'system', content: systemTexts.join('\n') });
  merged.push(...nonSystemMessages);
  openAIRequest.messages = merged;
}

export function isMaxTokensUnsupportedError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes('max_tokens')
    && normalized.includes('max_completion_tokens')
    && normalized.includes('not supported');
}

/**
 * Detect errors where the upstream model does not support tool calling.
 * Ollama returns messages like "registry.ollama.ai/library/gemma3:1b does not support tools".
 */
export function isToolsUnsupportedError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes('does not support tools')
    || normalized.includes('tool use is not supported');
}

export function estimateTokenCountForText(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  // Heuristic fallback for non-Anthropic backends that do not implement count_tokens.
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function estimateTokenCountFromUnknown(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === 'string') {
    return estimateTokenCountForText(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return estimateTokenCountForText(String(value));
  }

  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateTokenCountFromUnknown(item), 0);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    let total = 0;
    for (const [key, nested] of Object.entries(obj)) {
      // Prefer semantically meaningful text fields; avoid double-counting structural keys.
      if (key === 'text' || key === 'content' || key === 'system' || key === 'name' || key === 'description') {
        total += estimateTokenCountFromUnknown(nested);
      }
    }
    return total;
  }

  return 0;
}

export function estimateAnthropicCountTokensRequestInputTokens(requestBody: unknown): number {
  const estimated = estimateTokenCountFromUnknown(requestBody);
  return Math.max(1, estimated);
}

export function writeJSON(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const decodeBody = (raw: Buffer): string => {
      if (raw.length === 0) {
        return '';
      }

      const collectStringValues = (input: unknown, out: string[]): void => {
        if (typeof input === 'string') {
          out.push(input);
          return;
        }
        if (Array.isArray(input)) {
          for (const item of input) collectStringValues(item, out);
          return;
        }
        if (input && typeof input === 'object') {
          for (const value of Object.values(input as Record<string, unknown>)) {
            collectStringValues(value, out);
          }
        }
      };

      const scoreDecodedJsonText = (text: string): number => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return -10000;
        }

        const values: string[] = [];
        collectStringValues(parsed, values);
        const joined = values.join('\n');
        if (!joined) return 0;

        const cjkCount = (joined.match(/[㐀-鿿]/g) || []).length;
        const replacementCount = (joined.match(/�/g) || []).length;
        const mojibakeCount = (joined.match(/[ÃÂÐÑØÙÞæçèéêëìíîïðñòóôõöøùúûüýþÿ]/g) || []).length;
        const nonAsciiCount = (joined.match(/[^\x00-\x7F]/g) || []).length;

        return cjkCount * 4 + nonAsciiCount - replacementCount * 8 - mojibakeCount * 3;
      };

      // BOM-aware decoding first.
      if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
        return new TextDecoder('utf-8', { fatal: false }).decode(raw.subarray(3));
      }
      if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
        return new TextDecoder('utf-16le', { fatal: false }).decode(raw.subarray(2));
      }
      if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
        return new TextDecoder('utf-16be', { fatal: false }).decode(raw.subarray(2));
      }

      // Try strict UTF-8 first.
      let utf8Decoded: string | null = null;
      try {
        utf8Decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        utf8Decoded = null;
      }

      // On Windows local shells (especially Git Bash/curl paths), requests
      // may be emitted in system codepage instead of UTF-8.
      if (process.platform === 'win32') {
        let gbDecoded: string | null = null;
        try {
          gbDecoded = new TextDecoder('gb18030', { fatal: true }).decode(raw);
        } catch {
          gbDecoded = null;
        }

        if (utf8Decoded && gbDecoded) {
          const utf8Score = scoreDecodedJsonText(utf8Decoded);
          const gbScore = scoreDecodedJsonText(gbDecoded);
          if (gbScore > utf8Score) {
            console.warn(`[CoworkProxy] Decoded request body using gb18030 (score ${gbScore} > utf8 ${utf8Score})`);
            return gbDecoded;
          }
          return utf8Decoded;
        }

        if (gbDecoded && !utf8Decoded) {
          console.warn('[CoworkProxy] Decoded request body using gb18030 fallback');
          return gbDecoded;
        }
      }

      if (utf8Decoded) {
        return utf8Decoded;
      }

      return new TextDecoder('utf-8', { fatal: false }).decode(raw);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > 20 * 1024 * 1024) {
        fail(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const body = decodeBody(Buffer.concat(chunks));
      resolve(body);
    });

    req.on('error', (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function cacheToolCallExtraContent(toolCallId: string, extraContent: unknown): void {
  if (!toolCallId || extraContent === undefined) {
    return;
  }

  toolCallExtraContentById.set(toolCallId, extraContent);

  if (toolCallExtraContentById.size > MAX_TOOL_CALL_EXTRA_CONTENT_CACHE) {
    const oldestKey = toolCallExtraContentById.keys().next().value;
    if (typeof oldestKey === 'string') {
      toolCallExtraContentById.delete(oldestKey);
    }
  }
}

export function cacheToolCallExtraContentFromOpenAIToolCalls(toolCalls: unknown): void {
  for (const toolCall of toArray(toolCalls)) {
    const toolCallObj = toOptionalObject(toolCall);
    if (!toolCallObj) {
      continue;
    }

    const toolCallId = toString(toolCallObj.id);
    const extraContent = normalizeToolCallExtraContent(toolCallObj);
    cacheToolCallExtraContent(toolCallId, extraContent);
  }
}

export function cacheToolCallExtraContentFromOpenAIResponse(body: unknown): void {
  const responseObj = toOptionalObject(body);
  if (!responseObj) {
    return;
  }

  const firstChoice = toOptionalObject(toArray(responseObj.choices)[0]);
  if (!firstChoice) {
    return;
  }

  const message = toOptionalObject(firstChoice.message);
  if (!message) {
    return;
  }

  cacheToolCallExtraContentFromOpenAIToolCalls(message.tool_calls);
}

export function cacheToolCallExtraContentFromResponsesResponse(body: unknown): void {
  const { resolveResponsesObject } = require('./streamTransform');
  const responseObj = resolveResponsesObject(body);
  for (const item of toArray(responseObj.output)) {
    const itemObj = toOptionalObject(item);
    if (!itemObj || toString(itemObj.type) !== 'function_call') {
      continue;
    }
    const toolCallId = toString(itemObj.call_id) || toString(itemObj.id);
    const extraContent = normalizeToolCallExtraContent(itemObj);
    cacheToolCallExtraContent(toolCallId, extraContent);
  }
}

export function hydrateOpenAIRequestToolCalls(
  body: Record<string, unknown>,
  provider?: string,
  baseURL?: string
): void {
  const isGemini =
    provider === 'gemini' || Boolean(baseURL?.includes('generativelanguage.googleapis.com'));
  const messages = toArray(body.messages);
  for (const message of messages) {
    const messageObj = toOptionalObject(message);
    if (!messageObj) {
      continue;
    }

    for (const toolCall of toArray(messageObj.tool_calls)) {
      const toolCallObj = toOptionalObject(toolCall);
      if (!toolCallObj) {
        continue;
      }

      const existingExtraContent = normalizeToolCallExtraContent(toolCallObj);
      if (existingExtraContent !== undefined) {
        continue;
      }

      const toolCallId = toString(toolCallObj.id);
      if (toolCallId) {
        const cachedExtraContent = toolCallExtraContentById.get(toolCallId);
        if (cachedExtraContent !== undefined) {
          toolCallObj.extra_content = cachedExtraContent;
          continue;
        }
      }

      if (isGemini) {
        // Gemini requires thought signatures for tool calls; use a documented fallback when missing.
        toolCallObj.extra_content = {
          google: {
            thought_signature: GEMINI_FALLBACK_THOUGHT_SIGNATURE,
          },
        };
      }
    }
  }
}

export function createAnthropicErrorBody(message: string, type = 'api_error'): Record<string, unknown> {
  return {
    type: 'error',
    error: {
      type,
      message,
    },
  };
}
