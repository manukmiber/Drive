// Where a Zeiko S3 account's object index lives (ADR-044, the owner's diagram: "1 user, 1 D1
// pengganti index.txt"). An account names a D1 binding of its own (`s3_accounts.index_binding`,
// e.g. S3_DB_01, added to the Worker by the relay); until it has one, its index is in the main DB.
// Index databases are created empty, so their tables are made here on first use and kept in step by
// a schema version, in the main DB and in every bound one alike.
import type { Env } from '../env';
import { S3Error } from '../lib/s3-errors';

/** Bindings an account's own index may use. */
export const INDEX_BINDING_RE = /^S3_DB_[A-Z0-9_]{1,40}$/;

const MIGRATIONS: string[][] = [
  // v1
  [
    `CREATE TABLE IF NOT EXISTS s3_index_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS s3_objects (
       user_id      TEXT NOT NULL,
       bucket       TEXT NOT NULL,
       key          TEXT NOT NULL,
       blob_id      TEXT NOT NULL,
       size         INTEGER NOT NULL,
       etag         TEXT NOT NULL,
       content_type TEXT,
       meta_json    TEXT,
       scan_status  TEXT NOT NULL DEFAULT 'pending',
       sha256       TEXT,
       modified_at  INTEGER NOT NULL,
       PRIMARY KEY (bucket, key)
     ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS s3_objects_user_idx ON s3_objects (user_id, bucket)`,
    `CREATE TABLE IF NOT EXISTS s3_uploads (
       id           TEXT PRIMARY KEY,
       user_id      TEXT NOT NULL,
       bucket       TEXT NOT NULL,
       key          TEXT NOT NULL,
       blob_id      TEXT NOT NULL,
       r2_upload_id TEXT NOT NULL,
       content_type TEXT,
       meta_json    TEXT,
       created_at   INTEGER NOT NULL,
       expires_at   INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS s3_uploads_bucket_idx ON s3_uploads (bucket, key, created_at)`,
    `CREATE INDEX IF NOT EXISTS s3_uploads_expiry_idx ON s3_uploads (expires_at)`,
    `CREATE TABLE IF NOT EXISTS s3_upload_parts (
       upload_id   TEXT NOT NULL,
       part_number INTEGER NOT NULL,
       etag        TEXT NOT NULL,
       size        INTEGER NOT NULL,
       created_at  INTEGER NOT NULL,
       PRIMARY KEY (upload_id, part_number)
     ) WITHOUT ROWID`,
  ],
  // v2: whether the object's bytes are also in both replica buckets (3 copies, ADR-047).
  [`ALTER TABLE s3_objects ADD COLUMN replicated INTEGER NOT NULL DEFAULT 0`],
  // v3 (ADR-060): requests and bytes per bucket per WIB day, and access log lines waiting to be
  // delivered to the bucket's logging target.
  [
    `CREATE TABLE IF NOT EXISTS s3_bucket_days (
       user_id       TEXT NOT NULL,
       bucket        TEXT NOT NULL,
       day           INTEGER NOT NULL,
       requests      INTEGER NOT NULL DEFAULT 0,
       errors        INTEGER NOT NULL DEFAULT 0,
       ingress_bytes INTEGER NOT NULL DEFAULT 0,
       egress_bytes  INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (user_id, bucket, day)
     ) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS s3_log_lines (
       id      INTEGER PRIMARY KEY,
       user_id TEXT NOT NULL,
       bucket  TEXT NOT NULL,
       at      INTEGER NOT NULL,
       line    TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS s3_log_lines_bucket_idx ON s3_log_lines (user_id, bucket, id)`,
  ],
  // v4 (ADR-076): object tags, `[[key, value], …]`; an upload's tags until it is completed.
  [
    `ALTER TABLE s3_objects ADD COLUMN tags_json TEXT`,
    `ALTER TABLE s3_uploads ADD COLUMN tags_json TEXT`,
  ],
];
export const INDEX_SCHEMA_VERSION = MIGRATIONS.length;

const ready = new WeakMap<D1Database, Promise<void>>();

async function migrate(db: D1Database): Promise<void> {
  let version: number;
  try {
    const row = await db
      .prepare(`SELECT v FROM s3_index_meta WHERE k = 'schema'`)
      .first<{ v: number }>();
    version = row?.v ?? 0;
  } catch {
    version = 0; // no meta table yet: a fresh database
  }
  if (version >= INDEX_SCHEMA_VERSION) return;
  const stmts = MIGRATIONS.slice(version)
    .flat()
    .map((sql) => db.prepare(sql));
  stmts.push(
    db
      .prepare(
        `INSERT INTO s3_index_meta (k, v) VALUES ('schema', ?1) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
      )
      .bind(INDEX_SCHEMA_VERSION),
  );
  await db.batch(stmts);
}

/** Makes sure the index tables exist (once per database per isolate). */
export function ensureIndex(db: D1Database): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = migrate(db).catch((e: unknown) => {
      ready.delete(db);
      throw e;
    });
    ready.set(db, p);
  }
  return p;
}

/** The D1 binding by that name, if the Worker has one. */
export function boundIndex(env: Env, binding: string): D1Database | null {
  if (!INDEX_BINDING_RE.test(binding)) return null;
  const db = (env as unknown as Record<string, unknown>)[binding];
  return db && typeof (db as D1Database).prepare === 'function' ? (db as D1Database) : null;
}

/** Every per-account index binding this Worker has (for the relay's setup screen). */
export function indexBindings(env: Env): string[] {
  return Object.keys(env)
    .filter((k) => INDEX_BINDING_RE.test(k) && boundIndex(env, k))
    .sort();
}

/** The account's index database, ready to use. */
export async function indexDb(env: Env, binding: string | null): Promise<D1Database> {
  const db = binding ? boundIndex(env, binding) : env.DB;
  if (!db) {
    // The account points at a database this Worker isn't bound to (e.g. a deploy dropped it).
    throw new S3Error('ServiceUnavailable', 'This account’s index is not reachable right now.');
  }
  await ensureIndex(db);
  return db;
}
