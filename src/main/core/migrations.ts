import path from 'path';
import fs from 'fs';
import { app } from 'electron';

const USER_MEMORIES_MIGRATION_KEY = 'userMemories.migration.v1.completed';

function tryReadLegacyMemoryText(): string {
  const candidates = [
    path.join(process.cwd(), 'MEMORY.md'),
    path.join(app.getAppPath(), 'MEMORY.md'),
    path.join(process.cwd(), 'memory.md'),
    path.join(app.getAppPath(), 'memory.md'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.readFileSync(candidate, 'utf8');
      }
    } catch {
      // Skip unreadable candidates.
    }
  }
  return '';
}

function parseLegacyMemoryEntries(raw: string): string[] {
  const normalized = raw.replace(/```[\s\S]*?```/g, ' ');
  const lines = normalized.split(/\r?\n/);
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const match = line.trim().match(/^-+\s*(?:\[[^\]]+\]\s*)?(.+)$/);
    if (!match?.[1]) continue;
    const text = match[1].replace(/\s+/g, ' ').trim();
    if (!text || text.length < 6) continue;
    if (/^\(empty\)$/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(text.length > 360 ? `${text.slice(0, 359)}…` : text);
  }

  return entries.slice(0, 200);
}

function memoryFingerprint(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return require('crypto').createHash('sha1').update(normalized).digest('hex');
}

export function migrateLegacyMemoryFileToUserMemories(db: any, storeGet: (key: string) => any, storeSet: (key: string, value: any) => void): void {
  if (storeGet(USER_MEMORIES_MIGRATION_KEY) === '1') {
    return;
  }

  const content = tryReadLegacyMemoryText();
  if (!content.trim()) {
    storeSet(USER_MEMORIES_MIGRATION_KEY, '1');
    return;
  }

  const entries = parseLegacyMemoryEntries(content);
  if (entries.length === 0) {
    storeSet(USER_MEMORIES_MIGRATION_KEY, '1');
    return;
  }

  const now = Date.now();
  const crypto = require('crypto');
  db.run('BEGIN TRANSACTION;');
  try {
    for (const text of entries) {
      const fp = memoryFingerprint(text);
      const existing = db.exec(
        `SELECT id FROM user_memories WHERE fingerprint = ? AND status != 'deleted' LIMIT 1`,
        [fp]
      );
      if (existing[0]?.values?.[0]?.[0]) {
        continue;
      }

      const memoryId = crypto.randomUUID();
      db.run(`
        INSERT INTO user_memories (
          id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, ?, 1, 'created', ?, ?, NULL)
      `, [memoryId, text, fp, 0.9, now, now]);

      db.run(`
        INSERT INTO user_memory_sources (id, memory_id, session_id, message_id, role, is_active, created_at)
        VALUES (?, ?, NULL, NULL, 'system', 1, ?)
      `, [crypto.randomUUID(), memoryId, now]);
    }

    db.run('COMMIT;');
  } catch (error) {
    db.run('ROLLBACK;');
    console.warn('Failed to migrate legacy MEMORY.md entries:', error);
  }

  storeSet(USER_MEMORIES_MIGRATION_KEY, '1');
}

export function migrateFromElectronStore(db: any, userDataPath: string, saveFn: () => void): void {
  const result = db.exec('SELECT COUNT(*) as count FROM kv');
  const count = result[0]?.values[0]?.[0] as number;
  if (count > 0) return;

  const legacyPath = path.join(userDataPath, 'config.json');
  if (!fs.existsSync(legacyPath)) return;

  try {
    const raw = fs.readFileSync(legacyPath, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return;

    const entries = Object.entries(data);
    if (!entries.length) return;

    const now = Date.now();
    db.run('BEGIN TRANSACTION;');
    try {
      entries.forEach(([key, value]) => {
        db.run(`
          INSERT INTO kv (key, value, updated_at)
          VALUES (?, ?, ?)
        `, [key, JSON.stringify(value), now]);
      });
      db.run('COMMIT;');
      saveFn();
      console.info(`Migrated ${entries.length} entries from electron-store.`);
    } catch (error) {
      db.run('ROLLBACK;');
      throw error;
    }
  } catch (error) {
    console.warn('Failed to migrate electron-store data:', error);
  }
}
