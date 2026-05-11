export const coworkMigrations = [
  {
    name: 'cowork_v1_init',
    sql: `
      CREATE TABLE IF NOT EXISTS cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        pinned INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        execution_mode TEXT,
        active_skill_ids TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        sequence INTEGER,
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_id ON cowork_messages(session_id);

      CREATE TABLE IF NOT EXISTS cowork_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `
  },
  {
    name: 'cowork_add_execution_mode',
    sql: `ALTER TABLE cowork_sessions ADD COLUMN execution_mode TEXT;`
  },
  {
    name: 'cowork_add_pinned',
    sql: `ALTER TABLE cowork_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`
  },
  {
    name: 'cowork_add_active_skill_ids',
    sql: `ALTER TABLE cowork_sessions ADD COLUMN active_skill_ids TEXT;`
  },
  {
    name: 'cowork_add_sequence',
    sql: `ALTER TABLE cowork_messages ADD COLUMN sequence INTEGER;`
  }
];
