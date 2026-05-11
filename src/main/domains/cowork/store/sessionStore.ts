import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { getOne, getAll } from './dbHelpers';
import type {
  CoworkSession,
  CoworkSessionSummary,
  CoworkExecutionMode,
  CoworkSessionStatus,
} from '../types';

const TASK_WORKSPACE_CONTAINER_DIR = '.lumiai-tasks';

const normalizeRecentWorkspacePath = (cwd: string): string => {
  const resolved = path.resolve(cwd);
  const marker = `${path.sep}${TASK_WORKSPACE_CONTAINER_DIR}${path.sep}`;
  const markerIndex = resolved.lastIndexOf(marker);
  if (markerIndex > 0) {
    return resolved.slice(0, markerIndex);
  }
  return resolved;
};

interface SessionRow {
  id: string;
  title: string;
  claude_session_id: string | null;
  status: string;
  pinned?: number | null;
  cwd: string;
  system_prompt: string;
  execution_mode?: string | null;
  active_skill_ids?: string | null;
  created_at: number;
  updated_at: number;
}

interface SessionSummaryRow {
  id: string;
  title: string;
  status: string;
  pinned: number | null;
  created_at: number;
  updated_at: number;
}

interface CwdRow {
  cwd: string;
  updated_at: number;
}

export class CoworkSessionStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

  create(
    title: string,
    cwd: string,
    systemPrompt: string = '',
    executionMode: CoworkExecutionMode = 'local',
    activeSkillIds: string[] = []
  ): CoworkSession {
    const id = uuidv4();
    const now = Date.now();

    this.db.run(`
      INSERT INTO cowork_sessions (id, title, claude_session_id, status, cwd, system_prompt, execution_mode, active_skill_ids, pinned, created_at, updated_at)
      VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?, 0, ?, ?)
    `, [id, title, cwd, systemPrompt, executionMode, JSON.stringify(activeSkillIds), now, now]);

    this.saveDb();

    return {
      id,
      title,
      claudeSessionId: null,
      status: 'idle',
      pinned: false,
      cwd,
      systemPrompt,
      executionMode,
      activeSkillIds,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  findById(id: string): CoworkSession | null {
    const row = getOne<SessionRow>(this.db, `
      SELECT id, title, claude_session_id, status, pinned, cwd, system_prompt, execution_mode, active_skill_ids, created_at, updated_at
      FROM cowork_sessions
      WHERE id = ?
    `, [id]);

    if (!row) return null;

    let activeSkillIds: string[] = [];
    if (row.active_skill_ids) {
      try {
        activeSkillIds = JSON.parse(row.active_skill_ids);
      } catch {
        activeSkillIds = [];
      }
    }

    return {
      id: row.id,
      title: row.title,
      claudeSessionId: row.claude_session_id,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      cwd: row.cwd,
      systemPrompt: row.system_prompt,
      executionMode: (row.execution_mode as CoworkExecutionMode) || 'local',
      activeSkillIds,
      messages: [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  update(
    id: string,
    updates: Partial<Pick<CoworkSession, 'title' | 'claudeSessionId' | 'status' | 'cwd' | 'systemPrompt' | 'executionMode'>>
  ): void {
    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [now];

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      values.push(updates.title);
    }
    if (updates.claudeSessionId !== undefined) {
      setClauses.push('claude_session_id = ?');
      values.push(updates.claudeSessionId);
    }
    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      values.push(updates.status);
    }
    if (updates.cwd !== undefined) {
      setClauses.push('cwd = ?');
      values.push(updates.cwd);
    }
    if (updates.systemPrompt !== undefined) {
      setClauses.push('system_prompt = ?');
      values.push(updates.systemPrompt);
    }
    if (updates.executionMode !== undefined) {
      setClauses.push('execution_mode = ?');
      values.push(updates.executionMode);
    }

    values.push(id);
    this.db.run(`
      UPDATE cowork_sessions
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `, values);

    this.saveDb();
  }

  delete(id: string): void {
    this.db.run('DELETE FROM cowork_sessions WHERE id = ?', [id]);
    this.saveDb();
  }

  deleteMany(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.run(`DELETE FROM cowork_sessions WHERE id IN (${placeholders})`, ids);
    this.saveDb();
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.run('UPDATE cowork_sessions SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
    this.saveDb();
  }

  listAll(): CoworkSessionSummary[] {
    const rows = getAll<SessionSummaryRow>(this.db, `
      SELECT id, title, status, pinned, created_at, updated_at
      FROM cowork_sessions
      ORDER BY pinned DESC, updated_at DESC
    `);

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  resetRunningToIdle(): number {
    const now = Date.now();
    this.db.run(`
      UPDATE cowork_sessions
      SET status = 'idle', updated_at = ?
      WHERE status = 'running'
    `, [now]);
    this.saveDb();

    const changes = this.db.getRowsModified?.();
    return typeof changes === 'number' ? changes : 0;
  }

  listRecentCwds(limit: number = 8): string[] {
    const rows = getAll<CwdRow>(this.db, `
      SELECT cwd, updated_at
      FROM cowork_sessions
      WHERE cwd IS NOT NULL AND TRIM(cwd) != ''
      ORDER BY updated_at DESC
      LIMIT ?
    `, [Math.max(limit * 8, limit)]);

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const normalized = normalizeRecentWorkspacePath(row.cwd);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      deduped.push(normalized);
      if (deduped.length >= limit) {
        break;
      }
    }

    return deduped;
  }
}
