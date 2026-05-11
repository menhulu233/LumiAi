import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { Database } from 'sql.js';
import { getOne } from './dbHelpers';
import type { CoworkConfig, CoworkConfigUpdate, CoworkExecutionMode } from '../types';
import {
  normalizeMemoryGuardLevel,
  parseBooleanConfig,
  clampMemoryUserMemoriesMaxItems,
  DEFAULT_MEMORY_ENABLED,
  DEFAULT_MEMORY_IMPLICIT_UPDATE_ENABLED,
  DEFAULT_MEMORY_LLM_JUDGE_ENABLED,
  DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS,
} from '../../../utils/validators';

const getDefaultWorkingDirectory = (): string => {
  return path.join(require('os').homedir(), 'lumiai', 'project');
};

let cachedDefaultSystemPrompt: string | null = null;

const getDefaultSystemPrompt = (): string => {
  if (cachedDefaultSystemPrompt !== null) {
    return cachedDefaultSystemPrompt;
  }

  try {
    const promptPath = path.join(app.getAppPath(), 'sandbox', 'agent-runner', 'AGENT_SYSTEM_PROMPT.md');
    cachedDefaultSystemPrompt = fs.readFileSync(promptPath, 'utf-8');
  } catch (error) {
    console.warn('Failed to load default system prompt:', error);
    cachedDefaultSystemPrompt = '';
  }

  return cachedDefaultSystemPrompt;
};

interface ConfigRow {
  value: string;
}

export class CoworkConfigStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

  get(): CoworkConfig {
    const workingDirRow = getOne<ConfigRow>(this.db, 'SELECT value FROM cowork_config WHERE key = ?', ['workingDirectory']);
    const executionModeRow = getOne<ConfigRow>(this.db, 'SELECT value FROM cowork_config WHERE key = ?', ['executionMode']);
    const memoryEnabledRow = getOne<ConfigRow>(this.db, 'SELECT value FROM cowork_config WHERE key = ?', ['memoryEnabled']);
    const memoryImplicitUpdateEnabledRow = getOne<ConfigRow>(this.db, 'SELECT value FROM cowork_config WHERE key = ?', ['memoryImplicitUpdateEnabled']);
    const memoryLlmJudgeEnabledRow = getOne<ConfigRow>(this.db, 'SELECT value FROM cowork_config WHERE key = ?', ['memoryLlmJudgeEnabled']);
    const memoryGuardLevelRow = getOne<ConfigRow>(this.db, 'SELECT value FROM cowork_config WHERE key = ?', ['memoryGuardLevel']);
    const memoryUserMemoriesMaxItemsRow = getOne<ConfigRow>(this.db, 'SELECT value FROM cowork_config WHERE key = ?', ['memoryUserMemoriesMaxItems']);

    const normalizedExecutionMode =
      executionModeRow?.value === 'container' ? 'sandbox' : (executionModeRow?.value as CoworkExecutionMode);

    return {
      workingDirectory: workingDirRow?.value || getDefaultWorkingDirectory(),
      systemPrompt: getDefaultSystemPrompt(),
      executionMode: normalizedExecutionMode || 'local',
      memoryEnabled: parseBooleanConfig(memoryEnabledRow?.value, DEFAULT_MEMORY_ENABLED),
      memoryImplicitUpdateEnabled: parseBooleanConfig(
        memoryImplicitUpdateEnabledRow?.value,
        DEFAULT_MEMORY_IMPLICIT_UPDATE_ENABLED
      ),
      memoryLlmJudgeEnabled: parseBooleanConfig(
        memoryLlmJudgeEnabledRow?.value,
        DEFAULT_MEMORY_LLM_JUDGE_ENABLED
      ),
      memoryGuardLevel: normalizeMemoryGuardLevel(memoryGuardLevelRow?.value),
      memoryUserMemoriesMaxItems: clampMemoryUserMemoriesMaxItems(Number(memoryUserMemoriesMaxItemsRow?.value)),
    };
  }

  set(config: CoworkConfigUpdate): void {
    const now = Date.now();

    if (config.workingDirectory !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('workingDirectory', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [config.workingDirectory, now]);
    }

    if (config.executionMode !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('executionMode', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [config.executionMode, now]);
    }

    if (config.memoryEnabled !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('memoryEnabled', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [config.memoryEnabled ? '1' : '0', now]);
    }

    if (config.memoryImplicitUpdateEnabled !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('memoryImplicitUpdateEnabled', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [config.memoryImplicitUpdateEnabled ? '1' : '0', now]);
    }

    if (config.memoryLlmJudgeEnabled !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('memoryLlmJudgeEnabled', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [config.memoryLlmJudgeEnabled ? '1' : '0', now]);
    }

    if (config.memoryGuardLevel !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('memoryGuardLevel', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [normalizeMemoryGuardLevel(config.memoryGuardLevel), now]);
    }

    if (config.memoryUserMemoriesMaxItems !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('memoryUserMemoriesMaxItems', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [String(clampMemoryUserMemoriesMaxItems(config.memoryUserMemoriesMaxItems)), now]);
    }

    this.saveDb();
  }

  getAppLanguage(): 'zh' | 'en' {
    interface KvRow {
      value: string;
    }

    const row = getOne<KvRow>(this.db, 'SELECT value FROM kv WHERE key = ?', ['app_config']);
    if (!row?.value) {
      return 'zh';
    }

    try {
      const config = JSON.parse(row.value) as { language?: string };
      return config.language === 'en' ? 'en' : 'zh';
    } catch {
      return 'zh';
    }
  }
}
