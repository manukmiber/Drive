// KVNamespace shim backed by SQLite (separate file from D1).
import type { DatabaseSync } from 'node:sqlite';

type GetType = 'text' | 'json' | 'arrayBuffer' | 'stream';

export class ShimKV {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY, value BLOB NOT NULL, expiration INTEGER, metadata TEXT)`);
  }

  private row(key: string): { value: Uint8Array; metadata: string | null } | null {
    const r = this.db
      .prepare('SELECT value, expiration, metadata FROM kv WHERE key = ?')
      .get(key) as
      { value: Uint8Array; expiration: number | null; metadata: string | null } | undefined;
    if (!r) return null;
    if (r.expiration !== null && r.expiration * 1000 <= this.now()) {
      this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
      return null;
    }
    return r;
  }

  private decode(value: Uint8Array, type: GetType): unknown {
    if (type === 'arrayBuffer') return value.slice().buffer;
    if (type === 'stream') return new Blob([value.slice()]).stream();
    const text = new TextDecoder().decode(value);
    return type === 'json' ? JSON.parse(text) : text;
  }

  async get(key: string, opt?: GetType | { type?: GetType }): Promise<unknown> {
    const type = (typeof opt === 'string' ? opt : opt?.type) ?? 'text';
    const r = this.row(key);
    return r ? this.decode(r.value, type) : null;
  }

  async getWithMetadata(key: string, opt?: GetType | { type?: GetType }) {
    const type = (typeof opt === 'string' ? opt : opt?.type) ?? 'text';
    const r = this.row(key);
    if (!r) return { value: null, metadata: null, cacheStatus: null };
    return {
      value: this.decode(r.value, type),
      metadata: r.metadata ? (JSON.parse(r.metadata) as unknown) : null,
      cacheStatus: null,
    };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
  ): Promise<void> {
    let bytes: Uint8Array;
    if (typeof value === 'string') bytes = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value))
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
      throw new Error('KV PUT failed: 400 Invalid expiration_ttl of ' + options.expirationTtl);
    }
    const expiration =
      options?.expiration ??
      (options?.expirationTtl ? Math.floor(this.now() / 1000) + options.expirationTtl : null);
    this.db
      .prepare('INSERT OR REPLACE INTO kv (key, value, expiration, metadata) VALUES (?, ?, ?, ?)')
      .run(
        key,
        bytes,
        expiration,
        options?.metadata === undefined ? null : JSON.stringify(options.metadata),
      );
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    const prefix = options?.prefix ?? '';
    const limit = Math.min(options?.limit ?? 1000, 1000);
    const after = options?.cursor ?? '';
    const rows = this.db
      .prepare(
        `SELECT key, expiration, metadata FROM kv WHERE key >= ? AND key > ? AND substr(key, 1, ?) = ?
         AND (expiration IS NULL OR expiration * 1000 > ?) ORDER BY key LIMIT ?`,
      )
      .all(prefix, after, prefix.length, prefix, this.now(), limit + 1) as Array<{
      key: string;
      expiration: number | null;
      metadata: string | null;
    }>;
    const page = rows.slice(0, limit);
    const complete = rows.length <= limit;
    return {
      keys: page.map((r) => ({
        name: r.key,
        ...(r.expiration !== null ? { expiration: r.expiration } : {}),
        ...(r.metadata ? { metadata: JSON.parse(r.metadata) as unknown } : {}),
      })),
      list_complete: complete,
      ...(complete ? {} : { cursor: page[page.length - 1]!.key }),
      cacheStatus: null,
    };
  }
}
