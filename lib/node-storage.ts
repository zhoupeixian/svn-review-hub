import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

// Implements the D1/R2 operations used by this application, backed by one SQLite
// file so a stopped instance can be backed up and restored as a single volume.
export function createNodeStorage(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  sqlite.exec(`CREATE TABLE IF NOT EXISTS portal_objects (
    key TEXT PRIMARY KEY, content BLOB NOT NULL, metadata TEXT NOT NULL, uploaded TEXT NOT NULL
  )`);

  class Statement {
    constructor(readonly sql: string, readonly values: SQLInputValue[] = []) {}
    bind(...values: SQLInputValue[]) { return new Statement(this.sql, values); }
    execute() {
      const statement = sqlite.prepare(this.sql);
      const results = statement.all(...this.values);
      const meta = sqlite.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get()!;
      return { success: true, results, meta: { ...meta, duration: 0 } };
    }
    async all() { return this.execute(); }
    async run() { return this.execute(); }
    async first(column?: string) {
      const row = sqlite.prepare(this.sql).get(...this.values);
      return row ? (column ? row[column] : row) : null;
    }
    async raw(options?: { columnNames?: boolean }) {
      const statement = sqlite.prepare(this.sql);
      const rows = statement.all(...this.values).map((row) => Object.values(row));
      return options?.columnNames ? [statement.columns().map((column) => column.name), ...rows] : rows;
    }
  }

  const database = {
    prepare(sql: string) { return new Statement(sql); },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql: string) { sqlite.exec(sql); return { count: 1, duration: 0 }; },
  };

  function object(key: string) {
    const row = sqlite.prepare('SELECT content, metadata, uploaded FROM portal_objects WHERE key = ?').get(key);
    if (!row) return null;
    const content = Buffer.from(row.content as Uint8Array);
    const metadata = JSON.parse(String(row.metadata));
    const etag = createHash('sha256').update(content).digest('hex');
    return {
      key, size: content.length, etag, httpEtag: `"${etag}"`, uploaded: new Date(String(row.uploaded)),
      httpMetadata: metadata.httpMetadata, customMetadata: metadata.customMetadata,
      async text() { return content.toString('utf8'); },
      async arrayBuffer() { return Uint8Array.from(content).buffer; },
      get body() { return new Blob([content]).stream(); },
    };
  }

  const files = {
    async get(key: string) { return object(key); },
    async head(key: string) { return object(key); },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView, options: R2PutOptions = {}) {
      const content = typeof value === 'string' ? Buffer.from(value) :
        ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
      sqlite.prepare(`INSERT INTO portal_objects (key, content, metadata, uploaded) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET content=excluded.content, metadata=excluded.metadata, uploaded=excluded.uploaded`)
        .run(key, content, JSON.stringify({ httpMetadata: options.httpMetadata, customMetadata: options.customMetadata }), new Date().toISOString());
      return object(key);
    },
    async delete(keys: string | string[]) {
      const statement = sqlite.prepare('DELETE FROM portal_objects WHERE key = ?');
      for (const key of Array.isArray(keys) ? keys : [keys]) statement.run(key);
    },
    async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const prefix = options.prefix ?? '';
      const limit = Math.max(1, Math.min(options.limit ?? 1000, 1000));
      const rows = sqlite.prepare('SELECT key FROM portal_objects WHERE substr(key, 1, ?) = ? AND key > ? ORDER BY key LIMIT ?')
        .all(prefix.length, prefix, options.cursor ?? '', limit + 1);
      const page = rows.slice(0, limit);
      const truncated = rows.length > limit;
      return {
        objects: page.map((row) => object(String(row.key))!), truncated,
        cursor: truncated ? String(page.at(-1)!.key) : undefined, delimitedPrefixes: [],
      };
    },
  };

  return { DB: database as unknown as D1Database, FILES: files as unknown as R2Bucket, close: () => sqlite.close() };
}
