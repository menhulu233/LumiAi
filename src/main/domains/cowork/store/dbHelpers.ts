import { Database } from 'sql.js';

export function getOne<T>(db: Database, sql: string, params: (string | number | null)[] = []): T | undefined {
  const result = db.exec(sql, params);
  if (!result[0]?.values[0]) return undefined;
  const columns = result[0].columns;
  const values = result[0].values[0];
  const row: Record<string, unknown> = {};
  columns.forEach((col, i) => { row[col] = values[i]; });
  return row as T;
}

export function getAll<T>(db: Database, sql: string, params: (string | number | null)[] = []): T[] {
  const result = db.exec(sql, params);
  if (!result[0]?.values) return [];
  const columns = result[0].columns;
  return result[0].values.map((values) => {
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => { row[col] = values[i]; });
    return row as T;
  });
}
