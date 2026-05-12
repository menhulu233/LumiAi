import type { CoworkMemoryGuardLevel } from '../domains/cowork/service/coworkMemoryExtractor';

const DEFAULT_MEMORY_ENABLED = true;
const DEFAULT_MEMORY_IMPLICIT_UPDATE_ENABLED = true;
const DEFAULT_MEMORY_LLM_JUDGE_ENABLED = false;
const DEFAULT_MEMORY_GUARD_LEVEL: CoworkMemoryGuardLevel = 'strict';
const DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS = 12;
const MIN_MEMORY_USER_MEMORIES_MAX_ITEMS = 1;
const MAX_MEMORY_USER_MEMORIES_MAX_ITEMS = 60;
const MEMORY_NEAR_DUPLICATE_MIN_SCORE = 0.82;
const MEMORY_PROCEDURAL_TEXT_RE = /(执行以下命令|run\s+(?:the\s+)?following\s+command|\b(?:cd|npm|pnpm|yarn|node|python|bash|sh|git|curl|wget)\b|\$[A-Z_][A-Z0-9_]*|&&|--[a-z0-9-]+|\/tmp\/|\.sh\b|\.bat\b|\.ps1\b)/i;
const MEMORY_ASSISTANT_STYLE_TEXT_RE = /^(?:使用|use)\s+[A-Za-z0-9._-]+\s*(?:技能|skill)/i;

function normalizeMemoryGuardLevel(value: string | undefined): CoworkMemoryGuardLevel {
  if (value === 'strict' || value === 'standard' || value === 'relaxed') return value;
  return DEFAULT_MEMORY_GUARD_LEVEL;
}

function parseBooleanConfig(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function clampMemoryUserMemoriesMaxItems(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS;
  return Math.max(
    MIN_MEMORY_USER_MEMORIES_MAX_ITEMS,
    Math.min(MAX_MEMORY_USER_MEMORIES_MAX_ITEMS, Math.floor(value))
  );
}

export {
  DEFAULT_MEMORY_ENABLED,
  DEFAULT_MEMORY_IMPLICIT_UPDATE_ENABLED,
  DEFAULT_MEMORY_LLM_JUDGE_ENABLED,
  DEFAULT_MEMORY_GUARD_LEVEL,
  DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS,
  MIN_MEMORY_USER_MEMORIES_MAX_ITEMS,
  MAX_MEMORY_USER_MEMORIES_MAX_ITEMS,
  MEMORY_NEAR_DUPLICATE_MIN_SCORE,
  MEMORY_PROCEDURAL_TEXT_RE,
  MEMORY_ASSISTANT_STYLE_TEXT_RE,
  normalizeMemoryGuardLevel,
  parseBooleanConfig,
  clampMemoryUserMemoriesMaxItems,
};
