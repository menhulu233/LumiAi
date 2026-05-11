import { app } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { DB_FILENAME } from '../../appConstants';

type ChangePayload<T = unknown> = {
  key: string;
  newValue: T | undefined;
  oldValue: T | undefined;
};

export interface Migration {
  name: string;
  sql: string;
}

function loadWasmBinary(): ArrayBuffer {
  const wasmPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked/node_modules/sql.js/dist/sql-wasm.wasm')
    : path.join(app.getAppPath(), 'node_modules/sql.js/dist/sql-wasm.wasm');
  const buf = fs.readFileSync(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export class KvStore {
  private db: Database;
  private dbPath: string;
  private emitter = new EventEmitter();
  private static sqlPromise: Promise<SqlJsStatic> | null = null;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(userDataPath: string, migrations: Migration[] = []): Promise<KvStore> {
    const dbPath = path.join(userDataPath, DB_FILENAME);

    if (!KvStore.sqlPromise) {
      const wasmBinary = loadWasmBinary();
      KvStore.sqlPromise = initSqlJs({ wasmBinary });
    }
    const SQL = await KvStore.sqlPromise;

    let db: Database;
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    const store = new KvStore(db, dbPath);
    store.initializeCoreTables();

    // Apply domain migrations
    for (const m of migrations) {
      store.applyMigration(m);
    }

    store.save();
    return store;
  }

  private initializeCoreTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Migration tracking table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
  }

  private applyMigration(migration: Migration): void {
    try {
      const result = this.db.exec('SELECT 1 FROM _migrations WHERE name = ?', [migration.name]);
      if (result[0]?.values?.length) {
        return; // Already applied
      }

      this.db.run(migration.sql);
      this.db.run('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [migration.name, Date.now()]);
    } catch (error) {
      console.error(`[KvStore] Migration failed: ${migration.name}`, error);
      throw error;
    }
  }

  save(): void {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  getDatabase(): Database {
    return this.db;
  }

  get<T = unknown>(key: string): T | undefined {
    const result = this.db.exec('SELECT value FROM kv WHERE key = ?', [key]);
    if (!result[0]?.values[0]) return undefined;
    const value = result[0].values[0][0] as string;
    try {
      return JSON.parse(value) as T;
    } catch {
      console.warn(`Failed to parse store value for ${key}`);
      return undefined;
    }
  }

  set<T = unknown>(key: string, value: T): void {
    const oldValue = this.get<T>(key);
    const now = Date.now();
    this.db.run(`
      INSERT INTO kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [key, JSON.stringify(value), now]);
    this.save();
    this.emitter.emit('change', { key, newValue: value, oldValue } as ChangePayload<T>);
  }

  delete(key: string): void {
    const oldValue = this.get(key);
    this.db.run('DELETE FROM kv WHERE key = ?', [key]);
    this.save();
    this.emitter.emit('change', { key, newValue: undefined, oldValue } as ChangePayload);
  }

  onDidChange<T = unknown>(
    key: string,
    callback: (newValue: T | undefined, oldValue: T | undefined) => void
  ): () => void {
    const handler = (payload: ChangePayload<T>) => {
      if (payload.key !== key) return;
      callback(payload.newValue, payload.oldValue);
    };
    this.emitter.on('change', handler);
    return () => this.emitter.off('change', handler);
  }
}
