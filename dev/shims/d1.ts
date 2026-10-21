// D1Database shim over node:sqlite (ADR-001). Mirrors the parts of the D1 client API we rely on:
// prepare/bind/first/all/run/raw, batch (atomic), exec, and meta.changes / meta.last_row_id.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

type Bindable = null | number | bigint | string | Uint8Array;

const WRITE_RE = /^\s*(?:with\b[\s\S]*?\)\s*)?(insert|update|delete|replace)\b/i;

function toBindable(v: unknown, index: number): Bindable {
  if (v === undefined) {
    throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value at index ${index}`);
  }
  if (v === null || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string')
    return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error(`D1_TYPE_ERROR: Type '${typeof v}' not supported for value at index ${index}`);
}

function d1Error(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  const err = new Error(`D1_ERROR: ${msg}`);
  (err as Error & { cause?: unknown }).cause = e;
  return err;
}

interface Meta {
  duration: number;
  changes: number;
  last_row_id: number;
  changed_db: boolean;
  size_after: number;
  rows_read: number;
  rows_written: number;
  served_by: string;
}

interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: Meta;
}

export class ShimD1Database {
  private objStmts = new Map<string, StatementSync>();
  private arrStmts = new Map<string, StatementSync>();
  private changesStmt: StatementSync;
  /** Number of statements executed (handy for "no D1 query" assertions in tests). */
  queryCount = 0;

  constructor(readonly sqlite: DatabaseSync) {
    this.changesStmt = sqlite.prepare('SELECT changes() AS c, last_insert_rowid() AS r');
  }

  prepare(sql: string): ShimD1PreparedStatement {
    return new ShimD1PreparedStatement(this, sql, []);
  }

  async batch(statements: ShimD1PreparedStatement[]): Promise<D1ResultLike[]> {
    // node:sqlite is synchronous, so the whole batch runs without interleaving — same
    // serialization guarantee D1 gives for batch().
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => this.execute(s.sql, s.params, 'objects'));
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw d1Error(e);
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    try {
      this.sqlite.exec(sql);
    } catch (e) {
      throw d1Error(e);
    }
    return {
      count: sql.split(';').filter((s) => s.trim()).length,
      duration: performance.now() - started,
    };
  }

  withSession(): this & { getBookmark(): string | null } {
    return Object.assign(this, { getBookmark: () => null });
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not supported by the dev shim');
  }

  /** @internal */
  execute(sql: string, params: Bindable[], mode: 'objects'): D1ResultLike;
  execute(sql: string, params: Bindable[], mode: 'arrays'): unknown[][];
  execute(sql: string, params: Bindable[], mode: 'objects' | 'arrays'): D1ResultLike | unknown[][] {
    this.queryCount++;
    const started = performance.now();
    const cache = mode === 'arrays' ? this.arrStmts : this.objStmts;
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = this.sqlite.prepare(sql);
      if (mode === 'arrays') stmt.setReturnArrays(true);
      cache.set(sql, stmt);
    }
    const returnsRows = stmt.columns().length > 0;
    if (mode === 'arrays') {
      if (!returnsRows) {
        stmt.run(...params);
        return [];
      }
      return stmt.all(...params) as unknown as unknown[][];
    }

    let results: Record<string, unknown>[] = [];
    let changes = 0;
    let lastRowId = 0;
    if (returnsRows) {
      results = stmt.all(...params) as Record<string, unknown>[];
      if (WRITE_RE.test(sql)) {
        const ch = this.changesStmt.get() as { c: number; r: number };
        changes = ch.c;
        lastRowId = ch.r;
      }
    } else {
      const r = stmt.run(...params);
      changes = Number(r.changes);
      lastRowId = Number(r.lastInsertRowid);
    }
    return {
      results,
      success: true,
      meta: {
        duration: performance.now() - started,
        changes,
        last_row_id: lastRowId,
        changed_db: changes > 0,
        size_after: 0,
        rows_read: results.length,
        rows_written: changes,
        served_by: 'zeiko-dev-shim',
      },
    };
  }
}

export class ShimD1PreparedStatement {
  constructor(
    private db: ShimD1Database,
    readonly sql: string,
    readonly params: Bindable[],
  ) {}

  bind(...values: unknown[]): ShimD1PreparedStatement {
    return new ShimD1PreparedStatement(this.db, this.sql, values.map(toBindable));
  }

  private run_(mode: 'objects'): D1ResultLike;
  private run_(mode: 'arrays'): unknown[][];
  private run_(mode: 'objects' | 'arrays') {
    try {
      return mode === 'arrays'
        ? this.db.execute(this.sql, this.params, 'arrays')
        : this.db.execute(this.sql, this.params, 'objects');
    } catch (e) {
      throw d1Error(e);
    }
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const { results } = this.run_('objects');
    const row = results[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return this.run_('objects') as D1ResultLike<T>;
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return this.run_('objects') as D1ResultLike<T>;
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const rows = this.run_('arrays');
    if (!options?.columnNames) return rows as T[];
    const cols = this.db.sqlite
      .prepare(this.sql)
      .columns()
      .map((c) => c.name);
    return [cols, ...rows] as T[];
  }
}

export function openSqlite(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return db;
}
