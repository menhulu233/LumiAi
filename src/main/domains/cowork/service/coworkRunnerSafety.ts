import { truncateLargeContent } from './coworkRunnerHelpers';

const DELETE_TOOL_NAMES = new Set(['delete', 'remove', 'unlink', 'rmdir']);
const DELETE_COMMAND_RE = /\b(rm|rmdir|unlink|del|erase|remove-item)\b/i;
const FIND_DELETE_COMMAND_RE = /\bfind\b[\s\S]*\s-delete\b/i;
const GIT_CLEAN_COMMAND_RE = /\bgit\s+clean\b/i;
const SAFETY_APPROVAL_ALLOW_OPTION = '允许本次操作';
const SAFETY_APPROVAL_DENY_OPTION = '拒绝本次操作';
const PYTHON_BASH_COMMAND_RE = /(?:^|[^\w.-])(?:python(?:3)?|py(?:\.exe)?|pip(?:3)?)(?:\s+-3)?(?:\s|$)|\.py(?:\s|$)/i;
const PYTHON_PIP_BASH_COMMAND_RE = /(?:^|[^\w.-])(?:pip(?:3)?|python(?:3)?\s+-m\s+pip|py(?:\.exe)?\s+-m\s+pip)(?:\s|$)/i;

const TOOL_INPUT_PREVIEW_MAX_CHARS = 4000;
const TOOL_INPUT_PREVIEW_MAX_DEPTH = 5;
const TOOL_INPUT_PREVIEW_MAX_KEYS = 60;
const TOOL_INPUT_PREVIEW_MAX_ITEMS = 30;

export function extractToolCommand(toolInput: Record<string, unknown>): string {
  const commandLike = toolInput.command ?? toolInput.cmd ?? toolInput.script;
  return typeof commandLike === 'string' ? commandLike : '';
}

export function isDeleteOperation(toolName: string, toolInput: Record<string, unknown>): boolean {
  const normalizedToolName = toolName.toLowerCase();
  if (DELETE_TOOL_NAMES.has(normalizedToolName)) {
    return true;
  }

  if (normalizedToolName !== 'bash') {
    return false;
  }

  const command = extractToolCommand(toolInput);
  if (!command.trim()) {
    return false;
  }
  return DELETE_COMMAND_RE.test(command)
    || FIND_DELETE_COMMAND_RE.test(command)
    || GIT_CLEAN_COMMAND_RE.test(command);
}

export function truncateCommandPreview(command: string, maxLength = 120): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}

export function sanitizeToolPayload(
  value: unknown,
  options: {
    maxDepth?: number;
    maxStringChars?: number;
    maxKeys?: number;
    maxItems?: number;
  } = {}
): unknown {
  const maxDepth = options.maxDepth ?? TOOL_INPUT_PREVIEW_MAX_DEPTH;
  const maxStringChars = options.maxStringChars ?? TOOL_INPUT_PREVIEW_MAX_CHARS;
  const maxKeys = options.maxKeys ?? TOOL_INPUT_PREVIEW_MAX_KEYS;
  const maxItems = options.maxItems ?? TOOL_INPUT_PREVIEW_MAX_ITEMS;
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (
      current === null
      || typeof current === 'number'
      || typeof current === 'boolean'
      || typeof current === 'undefined'
    ) {
      return current;
    }
    if (typeof current === 'string') {
      return truncateLargeContent(current, maxStringChars);
    }
    if (typeof current === 'bigint') {
      return current.toString();
    }
    if (typeof current === 'function') {
      return '[function]';
    }
    if (depth >= maxDepth) {
      return '[truncated-depth]';
    }
    if (Array.isArray(current)) {
      const sanitized = current.slice(0, maxItems).map((item) => visit(item, depth + 1));
      if (current.length > maxItems) {
        sanitized.push(`[truncated-items:${current.length - maxItems}]`);
      }
      return sanitized;
    }
    if (typeof current === 'object') {
      if (seen.has(current as object)) {
        return '[circular]';
      }
      seen.add(current as object);
      const source = current as Record<string, unknown>;
      const entries = Object.entries(source);
      const sanitized: Record<string, unknown> = {};
      for (const [key, entryValue] of entries.slice(0, maxKeys)) {
        sanitized[key] = visit(entryValue, depth + 1);
      }
      if (entries.length > maxKeys) {
        sanitized.__truncated_keys__ = entries.length - maxKeys;
      }
      return sanitized;
    }
    return String(current);
  };

  return visit(value, 0);
}

export function buildSafetyQuestionInput(
  question: string,
  requestedToolName: string,
  requestedToolInput: Record<string, unknown>
): Record<string, unknown> {
  return {
    questions: [
      {
        header: '安全确认',
        question,
        options: [
          {
            label: SAFETY_APPROVAL_ALLOW_OPTION,
            description: '仅允许当前这一次操作继续执行。',
          },
          {
            label: SAFETY_APPROVAL_DENY_OPTION,
            description: '拒绝当前操作，保持文件安全边界。',
          },
        ],
      },
    ],
    answers: {},
    context: {
      requestedToolName,
      requestedToolInput: sanitizeToolPayload(requestedToolInput),
    },
  };
}

export function isSafetyApproval(result: { behavior: string; updatedInput?: unknown }, question: string): boolean {
  if (result.behavior === 'deny') {
    return false;
  }

  const updatedInput = result.updatedInput;
  if (!updatedInput || typeof updatedInput !== 'object') {
    return false;
  }

  const answers = (updatedInput as Record<string, unknown>).answers;
  if (!answers || typeof answers !== 'object') {
    return false;
  }

  const rawAnswer = (answers as Record<string, unknown>)[question];
  if (typeof rawAnswer !== 'string') {
    return false;
  }

  return rawAnswer
    .split('|||')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(SAFETY_APPROVAL_ALLOW_OPTION);
}

export function isPythonRelatedBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return PYTHON_BASH_COMMAND_RE.test(trimmed);
}

export function isPythonPipBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return PYTHON_PIP_BASH_COMMAND_RE.test(trimmed);
}
