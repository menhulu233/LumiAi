export const memoryMigrations = [
  {
    name: 'memory_v1_init',
    sql: `
      CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.75,
        is_explicit INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'created',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS user_memory_sources (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        session_id TEXT,
        message_id TEXT,
        role TEXT NOT NULL DEFAULT 'system',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES user_memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_user_memories_status_updated_at
        ON user_memories(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_user_memories_fingerprint
        ON user_memories(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_user_memory_sources_session_id
        ON user_memory_sources(session_id, is_active);
      CREATE INDEX IF NOT EXISTS idx_user_memory_sources_memory_id
        ON user_memory_sources(memory_id, is_active);
    `
  }
];
