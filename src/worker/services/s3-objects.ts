// Zeiko S3 data plane (ADR-044): objects, listings and multipart uploads. Bytes go to R2 under
// s3/{userId}/{blobId} (one folder per account); names, sizes and metadata live in the account's
// index database (services/s3-index.ts). Storage is reserved before bytes are written and settled
// after, like Drive's quota (SPEC §4), on the account's row in the main database. A replaced or
// deleted object's bytes are removed from R2 right away: nothing is shared between objects.
import { GIB, R2_MAX_PARTS, R2_MIN_PART_BYTES } from '../../shared/constants';
import type { ScanResult } from '../adapters/scanner';
import type { Ctx } from '../context';
import { randomBase62, ulid } from '../lib/ids';
import { S3Error } from '../lib/s3-errors';
import { log } from '../lib/log';
import { withKnownLength } from '../lib/zip';
import {
  commitBytes,
  getAccount,
  ownBucket,
  releaseBytes,
  reserveBytes,
  s3BlobKey,
  type S3Account,
} from './s3';
import { indexDb } from './s3-index';
import { notify } from './notify';
import type { ScanCarry } from '../queues/messages';
import { afterVirusTotal } from './scan';
import { deleteReplicas, replicateObject } from './s3-replicas';
import { releaseS3Url } from './s3-urls';
import { dropBucketStats, pruneBucketStats } from './s3-stats';

export const MAX_KEY_BYTES = 1024;
/** One PUT or CopyObject (Amazon's limit too; bigger objects are multipart). */
export const MAX_SINGLE_PUT_BYTES = 5 * GIB;
export const MAX_PART_BYTES = 5 * GIB;
export const MAX_USER_META_BYTES = 2048;

/** Stored HTTP headers, given back on GET/HEAD. */
const SYSTEM_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'expires',
] as const;

export interface ObjectMeta {
  /** System headers (lowercase names). */
  h?: Record<string, string>;
  /** x-amz-meta-* without the prefix (lowercase names). */
  m?: Record<string, string>;
}

export interface ObjectRow {
  user_id: string;
  bucket: string;
  key: string;
  blob_id: string;
  size: number;
  etag: string;
  content_type: string | null;
  meta_json: string | null;
  scan_status: 'pending' | 'clean' | 'skipped' | 'error';
  sha256: string | null;
  modified_at: number;
}

const enc = new TextEncoder();

export function validateKey(key: string): void {
  if (!key) throw new S3Error('InvalidArgument', 'An object key is required.');
  if (enc.encode(key).length > MAX_KEY_BYTES)
    throw new S3Error('KeyTooLongError', 'Your key is too long (1024 bytes at most).');
  // XML 1.0 cannot carry most control characters, so listings could not return such a key.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key))
    throw new S3Error('InvalidArgument', 'Object keys may not contain control characters.');
}

export function metaFromHeaders(headers: Headers): ObjectMeta {
  const h: Record<string, string> = {};
  const m: Record<string, string> = {};
  for (const name of SYSTEM_HEADERS) {
    const v = headers.get(name);
    // aws-chunked is how the body travelled, not part of the object.
    if (v !== null && name === 'content-encoding') {
      const rest = v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && s !== 'aws-chunked');
      if (rest.length) h[name] = rest.join(', ');
    } else if (v !== null) h[name] = v;
  }
  let size = 0;
  for (const [name, value] of headers) {
    if (!name.startsWith('x-amz-meta-')) continue;
    const k = name.slice('x-amz-meta-'.length);
    m[k] = value;
    size += enc.encode(k).length + enc.encode(value).length;
  }
  if (size > MAX_USER_META_BYTES)
    throw new S3Error(
      'MetadataTooLarge',
      'Your metadata headers exceed the maximum allowed metadata size.',
    );
  return { ...(Object.keys(h).length ? { h } : {}), ...(Object.keys(m).length ? { m } : {}) };
}

export function parseMeta(row: Pick<ObjectRow, 'meta_json'>): ObjectMeta {
  if (!row.meta_json) return {};
  try {
    return JSON.parse(row.meta_json) as ObjectMeta;
  } catch {
    return {};
  }
}

function metaJson(meta: ObjectMeta): string | null {
  return meta.h || meta.m ? JSON.stringify(meta) : null;
}

/** R2 binding errors carry a numeric code in the message ("… (10024)"). */
function fromR2(e: unknown): unknown {
  if (e instanceof S3Error) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const code = /\((\d{5})\)/.exec(msg)?.[1];
  if (code === '10024') return new S3Error('NoSuchUpload', 'The specified upload does not exist.');
  if (code === '10011')
    return new S3Error(
      'EntityTooSmall',
      'Your proposed upload is smaller than the minimum allowed object size.',
    );
  if (code === '10025' || code === '10048')
    return new S3Error(
      'InvalidPart',
      'One or more of the specified parts could not be found or were not the same size.',
    );
  return e;
}

async function scanRequest(ctx: Ctx, row: ObjectRow): Promise<void> {
  if (row.scan_status !== 'pending') return;
  await ctx.env.SCAN_QUEUE.send({
    type: 's3_scan',
    userId: row.user_id,
    bucket: row.bucket,
    key: row.key,
    blobId: row.blob_id,
  });
}

/**
 * What a write needs to find under its name (ADR-068): nothing (If-None-Match: *), or the object
 * with this ETag (If-Match).
 */
export type WriteCondition = { ifNoneMatch: true } | { ifMatch: string };

const PRECONDITION = 'At least one of the pre-conditions you specified did not hold.';

/** The cheap early check, before any bytes move; the commit checks again. */
async function checkWrite(
  ctx: Ctx,
  account: Pick<S3Account, 'userId' | 'indexBinding'>,
  bucket: string,
  key: string,
  cond: WriteCondition | null | undefined,
): Promise<void> {
  if (!cond) return;
  const now = await getObjectRow(ctx, account, bucket, key);
  if ('ifNoneMatch' in cond ? now !== null : now?.etag !== cond.ifMatch)
    throw new S3Error('PreconditionFailed', PRECONDITION);
}

type Replaced = { blob_id: string; size: number } | null;

/**
 * Puts `row` in place of whatever had its name; returns what it replaced. With a condition, the
 * condition is part of the same D1 batch, so of two writers only one can see it hold:
 * `won: false` means nothing was written (`extra` still runs).
 */
async function replaceRow(
  db: D1Database,
  row: ObjectRow,
  extra: D1PreparedStatement[] = [],
  cond?: WriteCondition | null,
): Promise<{ won: boolean; old: Replaced }> {
  const name = `bucket = ?1 AND key = ?2 AND user_id = ?3`;
  const insert = (tail: string) =>
    db
      .prepare(
        `INSERT INTO s3_objects (user_id, bucket, key, blob_id, size, etag, content_type, meta_json, scan_status, sha256, modified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)${tail}`,
      )
      .bind(
        row.user_id,
        row.bucket,
        row.key,
        row.blob_id,
        row.size,
        row.etag,
        row.content_type,
        row.meta_json,
        row.scan_status,
        row.sha256,
        row.modified_at,
      );
  if (!cond) {
    const [deleted] = await db.batch([
      db
        .prepare(`DELETE FROM s3_objects WHERE ${name} RETURNING blob_id, size`)
        .bind(row.bucket, row.key, row.user_id),
      insert(''),
      ...extra,
    ]);
    return { won: true, old: (deleted?.results[0] as Replaced | undefined) ?? null };
  }
  if ('ifNoneMatch' in cond) {
    const [added] = await db.batch([
      insert(` ON CONFLICT (bucket, key) DO NOTHING RETURNING blob_id`),
      ...extra,
    ]);
    return { won: Boolean(added?.results.length), old: null };
  }
  // If-Match: the old row is read and replaced in one transaction, only while its ETag is the one
  // asked for. Every column is set, as a fresh INSERT would (replicated: the new bytes have no copies).
  const [before, updated] = await db.batch([
    db
      .prepare(`SELECT blob_id, size FROM s3_objects WHERE ${name} AND etag = ?4`)
      .bind(row.bucket, row.key, row.user_id, cond.ifMatch),
    db
      .prepare(
        `UPDATE s3_objects SET blob_id = ?5, size = ?6, etag = ?7, content_type = ?8, meta_json = ?9,
           scan_status = ?10, sha256 = ?11, modified_at = ?12, replicated = 0
         WHERE ${name} AND etag = ?4 RETURNING blob_id`,
      )
      .bind(
        row.bucket,
        row.key,
        row.user_id,
        cond.ifMatch,
        row.blob_id,
        row.size,
        row.etag,
        row.content_type,
        row.meta_json,
        row.scan_status,
        row.sha256,
        row.modified_at,
      ),
    ...extra,
  ]);
  if (!updated?.results.length) return { won: false, old: null };
  return { won: true, old: (before?.results[0] as Replaced | undefined) ?? null };
}

async function dropBlob(ctx: Ctx, userId: string, blobId: string): Promise<void> {
  const key = s3BlobKey(userId, blobId);
  await Promise.all([ctx.env.BUCKET.delete(key), deleteReplicas(ctx.env, [key])]).catch(
    (e: unknown) => log.warn('s3_blob_delete_failed', { blobId, message: String(e) }),
  );
}

// ───────────────────────────── objects ─────────────────────────────

export interface PutInput {
  bucket: string;
  key: string;
  body: ReadableStream<Uint8Array> | null;
  size: number;
  contentType: string | null;
  meta: ObjectMeta;
  /** Hex MD5 the client sent (Content-MD5), checked against what R2 stored. */
  md5Hex?: string | null;
  /** Runs once the bytes are stored, e.g. to compare the payload's SHA-256 (throws to undo). */
  verify?: () => Promise<void>;
  condition?: WriteCondition | null;
}

export async function putObject(ctx: Ctx, account: S3Account, input: PutInput): Promise<ObjectRow> {
  validateKey(input.key);
  if (input.size > MAX_SINGLE_PUT_BYTES)
    throw new S3Error(
      'EntityTooLarge',
      'Your proposed upload exceeds the maximum allowed size; use a multipart upload.',
    );
  const db = await indexDb(ctx.env, account.indexBinding);
  const userId = account.userId;
  await checkWrite(ctx, account, input.bucket, input.key, input.condition);
  await reserveBytes(ctx, userId, input.size);
  const blobId = ulid(ctx.now());
  const r2Key = s3BlobKey(userId, blobId);
  let stored = false;
  try {
    const body = input.body && input.size > 0 ? withKnownLength(input.body, input.size) : '';
    const obj = await ctx.env.BUCKET.put(r2Key, body, {
      httpMetadata: input.contentType ? { contentType: input.contentType } : {},
    });
    stored = true;
    if (!obj) throw new S3Error('InternalError', 'The object could not be stored.');
    if (obj.size !== input.size)
      throw new S3Error(
        'IncompleteBody',
        'You did not provide the number of bytes specified by the Content-Length HTTP header.',
      );
    await input.verify?.();
    if (input.md5Hex && obj.etag !== input.md5Hex)
      throw new S3Error(
        'BadDigest',
        'The Content-MD5 you specified did not match what we received.',
      );
    const row: ObjectRow = {
      user_id: userId,
      bucket: input.bucket,
      key: input.key,
      blob_id: blobId,
      size: obj.size,
      etag: obj.etag,
      content_type: input.contentType,
      meta_json: metaJson(input.meta),
      scan_status: obj.size === 0 ? 'clean' : 'pending',
      sha256: null,
      modified_at: ctx.now(),
    };
    const { won, old } = await replaceRow(db, row, [], input.condition);
    // Another writer got there first: this one's bytes go (below), as on any failed upload.
    if (!won) throw new S3Error('PreconditionFailed', PRECONDITION);
    await commitBytes(ctx, userId, input.size, row.size - (old?.size ?? 0));
    if (old) await dropBlob(ctx, userId, old.blob_id);
    await scanRequest(ctx, row);
    return row;
  } catch (e) {
    await releaseBytes(ctx, userId, input.size);
    if (stored) await dropBlob(ctx, userId, blobId);
    throw fromR2(e);
  }
}

export async function getObjectRow(
  ctx: Ctx,
  account: Pick<S3Account, 'userId' | 'indexBinding'>,
  bucket: string,
  key: string,
): Promise<ObjectRow | null> {
  const db = await indexDb(ctx.env, account.indexBinding);
  return db
    .prepare(`SELECT * FROM s3_objects WHERE bucket = ?1 AND key = ?2 AND user_id = ?3`)
    .bind(bucket, key, account.userId)
    .first<ObjectRow>();
}

export async function deleteObjects(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  keys: string[],
): Promise<void> {
  if (!keys.length) return;
  const db = await indexDb(ctx.env, account.indexBinding);
  const results = await db.batch(
    keys.map((k) =>
      db
        .prepare(
          `DELETE FROM s3_objects WHERE bucket = ?1 AND key = ?2 AND user_id = ?3 RETURNING blob_id, size`,
        )
        .bind(bucket, k, account.userId),
    ),
  );
  const gone = results.flatMap((r) => r.results as Array<{ blob_id: string; size: number }>);
  if (!gone.length) return;
  await commitBytes(ctx, account.userId, 0, -gone.reduce((n, g) => n + g.size, 0));
  const r2Keys = gone.map((g) => s3BlobKey(account.userId, g.blob_id));
  await Promise.all([ctx.env.BUCKET.delete(r2Keys), deleteReplicas(ctx.env, r2Keys)]).catch(
    (e: unknown) => log.warn('s3_blob_delete_failed', { count: gone.length, message: String(e) }),
  );
}

export interface CopyInput {
  from: { bucket: string; key: string };
  to: { bucket: string; key: string };
  /** REPLACE takes the request's metadata; COPY (default) keeps the source's. */
  replace: boolean;
  contentType: string | null;
  meta: ObjectMeta;
  /** x-amz-copy-source-if-*: about the source. */
  source?: SourceConditions;
  /** If-Match / If-None-Match: about what the copy replaces (ADR-068). */
  condition?: WriteCondition | null;
}

/** The x-amz-copy-source-if-* headers of CopyObject and UploadPartCopy. */
export interface SourceConditions {
  ifMatch?: string | null;
  ifNoneMatch?: string | null;
  ifModifiedSince?: string | null;
  ifUnmodifiedSince?: string | null;
}

const unquote = (s: string) => s.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
const tagMatches = (header: string, etag: string) =>
  header.split(',').some((t) => t.trim() === '*' || unquote(t) === etag);

/** Amazon's rules: a matching ETag outranks the unmodified date, a non-matching one the modified date. */
function copyPreconditions(src: ObjectRow, c: SourceConditions = {}) {
  const modified = Math.floor(src.modified_at / 1000) * 1000;
  const date = (v: string | null | undefined) => {
    const t = v ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? null : t;
  };
  const unmodifiedSince = date(c.ifUnmodifiedSince);
  const modifiedSince = date(c.ifModifiedSince);
  const holds =
    (c.ifMatch
      ? tagMatches(c.ifMatch, src.etag)
      : unmodifiedSince === null || modified <= unmodifiedSince) &&
    (c.ifNoneMatch
      ? !tagMatches(c.ifNoneMatch, src.etag)
      : modifiedSince === null || modified > modifiedSince);
  if (!holds) throw new S3Error('PreconditionFailed', PRECONDITION);
}

/** Server-side copy within one account (the bytes are copied in R2, so each object stands alone). */
export async function copyObject(
  ctx: Ctx,
  account: S3Account,
  input: CopyInput,
): Promise<ObjectRow> {
  validateKey(input.to.key);
  const userId = account.userId;
  await ownBucket(ctx, userId, input.from.bucket);
  const src = await getObjectRow(ctx, account, input.from.bucket, input.from.key);
  if (!src)
    throw new S3Error('NoSuchKey', 'The specified key does not exist.', { Key: input.from.key });
  copyPreconditions(src, input.source);
  const db = await indexDb(ctx.env, account.indexBinding);
  const same = input.from.bucket === input.to.bucket && input.from.key === input.to.key;
  await checkWrite(ctx, account, input.to.bucket, input.to.key, input.condition);
  const contentType = input.replace ? input.contentType : src.content_type;
  const meta = input.replace ? metaJson(input.meta) : src.meta_json;
  const now = ctx.now();
  if (same) {
    if (!input.replace)
      throw new S3Error(
        'InvalidRequest',
        'This copy request is illegal because it is trying to copy an object to itself without changing the object’s metadata.',
      );
    // Only the metadata changes: no bytes to move. If-None-Match: * failed above (the source is
    // there); If-Match is checked again in the UPDATE itself.
    const ifMatch =
      input.condition && 'ifMatch' in input.condition ? input.condition.ifMatch : null;
    const changed = await db
      .prepare(
        `UPDATE s3_objects SET content_type = ?4, meta_json = ?5, modified_at = ?6
         WHERE bucket = ?1 AND key = ?2 AND user_id = ?3${ifMatch === null ? '' : ' AND etag = ?7'}`,
      )
      .bind(
        src.bucket,
        src.key,
        userId,
        contentType,
        meta,
        now,
        ...(ifMatch === null ? [] : [ifMatch]),
      )
      .run();
    if (ifMatch !== null && !changed.meta.changes)
      throw new S3Error('PreconditionFailed', PRECONDITION);
    return { ...src, content_type: contentType, meta_json: meta, modified_at: now };
  }
  if (src.size > MAX_SINGLE_PUT_BYTES)
    throw new S3Error(
      'InvalidRequest',
      'The source is larger than 5 GiB; copy it with UploadPartCopy.',
    );
  await reserveBytes(ctx, userId, src.size);
  const blobId = ulid(now);
  let stored = false;
  try {
    const body = await ctx.env.BUCKET.get(s3BlobKey(userId, src.blob_id));
    if (!body || !('body' in body))
      throw new S3Error('NoSuchKey', 'The specified key does not exist.');
    const obj = await ctx.env.BUCKET.put(
      s3BlobKey(userId, blobId),
      withKnownLength(body.body, src.size),
      {
        httpMetadata: contentType ? { contentType } : {},
      },
    );
    stored = true;
    const row: ObjectRow = {
      ...src,
      bucket: input.to.bucket,
      key: input.to.key,
      blob_id: blobId,
      etag: obj?.etag ?? src.etag,
      content_type: contentType,
      meta_json: meta,
      // The bytes are the source's: so is the scan result.
      modified_at: now,
    };
    const { won, old } = await replaceRow(db, row, [], input.condition);
    if (!won) throw new S3Error('PreconditionFailed', PRECONDITION);
    await commitBytes(ctx, userId, src.size, src.size - (old?.size ?? 0));
    if (old) await dropBlob(ctx, userId, old.blob_id);
    await scanRequest(ctx, row);
    return row;
  } catch (e) {
    await releaseBytes(ctx, userId, src.size);
    if (stored) await dropBlob(ctx, userId, blobId);
    throw fromR2(e);
  }
}

// ───────────────────────────── listings ─────────────────────────────

/** The smallest string after every string that starts with `p` (UTF-8 order), or null. */
export function prefixEnd(p: string): string | null {
  const cps = Array.from(p);
  while (cps.length) {
    const last = cps.pop()!.codePointAt(0)!;
    if (last < 0x10ffff) {
      let next = last + 1;
      if (next >= 0xd800 && next <= 0xdfff) next = 0xe000;
      return cps.join('') + String.fromCodePoint(next);
    }
  }
  return null;
}

/** Where a listing stopped: after a key, or past a whole common prefix. */
export type ListCursor = { after: string } | { skip: string };

export interface ListInput {
  prefix: string;
  delimiter: string;
  maxKeys: number;
  /** Start strictly after this key (Marker / StartAfter), with Amazon's common-prefix rule. */
  marker?: string;
  /** Resume from a continuation token. */
  cursor?: ListCursor;
}

export interface ListResult {
  contents: Array<Pick<ObjectRow, 'key' | 'size' | 'etag' | 'modified_at'>>;
  prefixes: string[];
  truncated: boolean;
  next: ListCursor | null;
}

export async function listObjects(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  input: ListInput,
): Promise<ListResult> {
  const db = await indexDb(ctx.env, account.indexBinding);
  const cfg = await ctx.config();
  const { prefix, delimiter, maxKeys: max } = input;
  const upper = prefix ? prefixEnd(prefix) : null;
  const marker = input.cursor ? undefined : input.marker;
  let from = input.cursor && 'skip' in input.cursor ? prefixEnd(input.cursor.skip) : '';
  let after = input.cursor && 'after' in input.cursor ? input.cursor.after : (marker ?? '');
  const out: ListResult = { contents: [], prefixes: [], truncated: false, next: null };
  if (max <= 0 || from === null) return out;
  let count = 0;
  let cursor: ListCursor | null = null;
  const sql =
    `SELECT key, size, etag, modified_at FROM s3_objects
     WHERE bucket = ?1 AND user_id = ?2 AND key >= ?3 AND key >= ?4 AND key > ?5` +
    (upper ? ` AND key < ?7` : '') +
    ` ORDER BY key LIMIT ?6`;
  for (let q = 0; q < cfg.s3_list_max_queries; q++) {
    const limit = Math.min(1000, max - count + 1);
    const stmt = db.prepare(sql);
    const bound = upper
      ? stmt.bind(bucket, account.userId, prefix, from, after, limit, upper)
      : stmt.bind(bucket, account.userId, prefix, from, after, limit);
    const { results: rows } = await bound.all<ListResult['contents'][number]>();
    let jumped = false;
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j]!;
      if (count >= max) return { ...out, truncated: true, next: cursor };
      if (delimiter) {
        const i = r.key.indexOf(delimiter, prefix.length);
        if (i !== -1) {
          const cp = r.key.slice(0, i + delimiter.length);
          // A marker inside (or at) a common prefix means that prefix was already returned.
          if (!(marker && marker.startsWith(cp))) {
            out.prefixes.push(cp);
            count++;
          }
          cursor = { skip: cp };
          const next = rows[j + 1];
          if (next && !next.key.startsWith(cp)) continue;
          const end = prefixEnd(cp);
          if (end === null) return out;
          from = end;
          after = '';
          jumped = true;
          break;
        }
      }
      out.contents.push(r);
      count++;
      cursor = { after: r.key };
    }
    if (!jumped) {
      if (rows.length < limit) return out;
      after = (cursor as { after: string }).after;
    }
  }
  return { ...out, truncated: true, next: cursor };
}

/** Is there anything at all in this bucket (objects or unfinished uploads)? */
async function bucketUse(db: D1Database, userId: string, bucket: string) {
  const obj = await db
    .prepare(`SELECT 1 AS x FROM s3_objects WHERE bucket = ?1 AND user_id = ?2 LIMIT 1`)
    .bind(bucket, userId)
    .first<{ x: number }>();
  return Boolean(obj);
}

/** Deletes an empty bucket; its unfinished multipart uploads are aborted with it. */
export async function deleteBucket(ctx: Ctx, account: S3Account, name: string): Promise<void> {
  await ownBucket(ctx, account.userId, name);
  const db = await indexDb(ctx.env, account.indexBinding);
  if (await bucketUse(db, account.userId, name))
    throw new S3Error('BucketNotEmpty', 'The bucket you tried to delete is not empty.', {
      BucketName: name,
    });
  const { results: ups } = await db
    .prepare(`SELECT id FROM s3_uploads WHERE bucket = ?1 AND user_id = ?2 LIMIT 200`)
    .bind(name, account.userId)
    .all<{ id: string }>();
  for (const u of ups) await abortUpload(ctx, account, name, null, u.id);
  await ctx.env.DB.prepare(`DELETE FROM s3_buckets WHERE name = ?1 AND user_id = ?2`)
    .bind(name, account.userId)
    .run();
  await ctx.env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?1, ?2, 's3.bucket_deleted', 's3_bucket', ?3, NULL, ?4)`,
  )
    .bind(ulid(ctx.now()), account.userId, name, ctx.now())
    .run();
  // A PUT that raced the emptiness check must not leave objects without a bucket.
  await purgeBucketRows(ctx, account, db, name);
  await dropBucketStats(ctx, account, name);
  // Buckets that logged into this one stop logging (a new owner of the name must not get them).
  await ctx.env.DB.prepare(
    `UPDATE s3_buckets SET logging_json = NULL WHERE user_id = ?1 AND json_extract(logging_json, '$.target') = ?2`,
  )
    .bind(account.userId, name)
    .run();
}

async function purgeBucketRows(ctx: Ctx, account: S3Account, db: D1Database, bucket: string) {
  const { results } = await db
    .prepare(`SELECT key FROM s3_objects WHERE bucket = ?1 AND user_id = ?2 LIMIT 1000`)
    .bind(bucket, account.userId)
    .all<{ key: string }>();
  if (results.length)
    await deleteObjects(
      ctx,
      account,
      bucket,
      results.map((r) => r.key),
    );
}

// ───────────────────────────── multipart ─────────────────────────────

export interface UploadRow {
  id: string;
  user_id: string;
  bucket: string;
  key: string;
  blob_id: string;
  r2_upload_id: string;
  content_type: string | null;
  meta_json: string | null;
  created_at: number;
  expires_at: number;
}

export async function createUpload(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  contentType: string | null,
  meta: ObjectMeta,
): Promise<UploadRow> {
  validateKey(key);
  if (account.status !== 'active')
    throw new S3Error('AccountProblem', 'This Zeiko S3 account is suspended.');
  const db = await indexDb(ctx.env, account.indexBinding);
  const cfg = await ctx.config();
  const open = await db
    .prepare(`SELECT COUNT(*) AS n FROM s3_uploads WHERE user_id = ?1`)
    .bind(account.userId)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= cfg.s3_max_open_uploads_per_account)
    throw new S3Error(
      'SlowDown',
      'Too many unfinished multipart uploads; complete or abort some first.',
    );
  const now = ctx.now();
  const blobId = ulid(now);
  const mpu = await ctx.env.BUCKET.createMultipartUpload(s3BlobKey(account.userId, blobId), {
    httpMetadata: contentType ? { contentType } : {},
  });
  const row: UploadRow = {
    id: randomBase62(40),
    user_id: account.userId,
    bucket,
    key,
    blob_id: blobId,
    r2_upload_id: mpu.uploadId,
    content_type: contentType,
    meta_json: metaJson(meta),
    created_at: now,
    expires_at: now + cfg.s3_multipart_ttl_hours * 3_600_000,
  };
  await db
    .prepare(
      `INSERT INTO s3_uploads (id, user_id, bucket, key, blob_id, r2_upload_id, content_type, meta_json, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      row.id,
      row.user_id,
      bucket,
      key,
      blobId,
      row.r2_upload_id,
      contentType,
      row.meta_json,
      now,
      row.expires_at,
    )
    .run();
  return row;
}

async function findUpload(
  db: D1Database,
  userId: string,
  bucket: string,
  key: string | null,
  uploadId: string,
): Promise<UploadRow> {
  const up = await db
    .prepare(`SELECT * FROM s3_uploads WHERE id = ?1 AND user_id = ?2 AND bucket = ?3`)
    .bind(uploadId, userId, bucket)
    .first<UploadRow>();
  if (!up || (key !== null && up.key !== key))
    throw new S3Error('NoSuchUpload', 'The specified upload does not exist.', {
      UploadId: uploadId,
    });
  return up;
}

function checkPartNumber(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > R2_MAX_PARTS)
    throw new S3Error(
      'InvalidArgument',
      'Part number must be an integer between 1 and 10000, inclusive.',
    );
}

async function storePart(
  ctx: Ctx,
  account: S3Account,
  db: D1Database,
  up: UploadRow,
  partNumber: number,
  size: number,
  body: () => Promise<ReadableStream<Uint8Array>>,
  verify?: () => Promise<void>,
): Promise<string> {
  await reserveBytes(ctx, account.userId, size);
  let etag: string;
  try {
    const mpu = ctx.env.BUCKET.resumeMultipartUpload(
      s3BlobKey(account.userId, up.blob_id),
      up.r2_upload_id,
    );
    const part = await mpu.uploadPart(partNumber, withKnownLength(await body(), size));
    await verify?.();
    etag = part.etag;
    const [old] = await db.batch([
      db
        .prepare(
          `DELETE FROM s3_upload_parts WHERE upload_id = ?1 AND part_number = ?2 RETURNING size`,
        )
        .bind(up.id, partNumber),
      db
        .prepare(
          `INSERT INTO s3_upload_parts (upload_id, part_number, etag, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(up.id, partNumber, etag, size, ctx.now()),
    ]);
    const replaced = (old?.results[0] as { size: number } | undefined)?.size ?? 0;
    await releaseBytes(ctx, account.userId, replaced);
  } catch (e) {
    await releaseBytes(ctx, account.userId, size);
    throw fromR2(e);
  }
  return etag;
}

export async function uploadPart(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  body: ReadableStream<Uint8Array> | null,
  size: number,
  verify?: () => Promise<void>,
): Promise<string> {
  checkPartNumber(partNumber);
  if (size > MAX_PART_BYTES) throw new S3Error('EntityTooLarge', 'A part may be 5 GiB at most.');
  const db = await indexDb(ctx.env, account.indexBinding);
  const up = await findUpload(db, account.userId, bucket, key, uploadId);
  return storePart(
    ctx,
    account,
    db,
    up,
    partNumber,
    size,
    async () => body ?? new ReadableStream({ start: (c) => c.close() }),
    verify,
  );
}

/** UploadPartCopy: a byte range of one of the account's objects becomes a part. */
export async function copyPart(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  from: { bucket: string; key: string },
  range: string | null,
  conditions: SourceConditions,
): Promise<{ etag: string; modifiedAt: number }> {
  checkPartNumber(partNumber);
  await ownBucket(ctx, account.userId, from.bucket);
  const src = await getObjectRow(ctx, account, from.bucket, from.key);
  if (!src) throw new S3Error('NoSuchKey', 'The specified key does not exist.', { Key: from.key });
  copyPreconditions(src, conditions);
  let offset = 0;
  let length = src.size;
  if (range) {
    const m = /^bytes=(\d+)-(\d+)$/.exec(range.trim());
    if (!m)
      throw new S3Error(
        'InvalidArgument',
        'The x-amz-copy-source-range value must be of the form bytes=first-last.',
      );
    offset = Number(m[1]);
    const last = Number(m[2]);
    if (last < offset || last >= src.size)
      throw new S3Error('InvalidRange', 'The requested range is not satisfiable.');
    length = last - offset + 1;
  }
  if (length > MAX_PART_BYTES) throw new S3Error('EntityTooLarge', 'A part may be 5 GiB at most.');
  const db = await indexDb(ctx.env, account.indexBinding);
  const up = await findUpload(db, account.userId, bucket, key, uploadId);
  const etag = await storePart(ctx, account, db, up, partNumber, length, async () => {
    const obj = await ctx.env.BUCKET.get(s3BlobKey(account.userId, src.blob_id), {
      range: { offset, length },
    });
    if (!obj || !('body' in obj))
      throw new S3Error('NoSuchKey', 'The specified key does not exist.');
    return obj.body;
  });
  return { etag, modifiedAt: ctx.now() };
}

interface PartRow {
  part_number: number;
  etag: string;
  size: number;
  created_at: number;
}

export async function completeUpload(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
  condition?: WriteCondition | null,
): Promise<ObjectRow> {
  const db = await indexDb(ctx.env, account.indexBinding);
  const up = await findUpload(db, account.userId, bucket, key, uploadId);
  if (!parts.length) throw new S3Error('MalformedXML', 'You must specify at least one part.');
  for (let i = 1; i < parts.length; i++) {
    if (parts[i]!.partNumber <= parts[i - 1]!.partNumber)
      throw new S3Error('InvalidPartOrder', 'The list of parts was not in ascending order.');
  }
  const { results: stored } = await db
    .prepare(
      `SELECT part_number, etag, size, created_at FROM s3_upload_parts WHERE upload_id = ?1 ORDER BY part_number`,
    )
    .bind(up.id)
    .all<PartRow>();
  const byNumber = new Map(stored.map((p) => [p.part_number, p]));
  const chosen = parts.map((p) => {
    const s = byNumber.get(p.partNumber);
    if (!s || unquote(p.etag) !== s.etag)
      throw new S3Error('InvalidPart', 'One or more of the specified parts could not be found.', {
        PartNumber: String(p.partNumber),
      });
    return s;
  });
  for (let i = 0; i < chosen.length - 1; i++) {
    if (chosen[i]!.size < R2_MIN_PART_BYTES)
      throw new S3Error('EntityTooSmall', 'Each part except the last must be at least 5 MiB.');
    if (chosen[i]!.size !== chosen[0]!.size)
      throw new S3Error(
        'InvalidPart',
        'Every part except the last must be the same size (a rule of the storage underneath).',
      );
  }
  if (chosen.length > 1 && chosen[chosen.length - 1]!.size > chosen[0]!.size)
    throw new S3Error('InvalidPart', 'The last part may not be larger than the others.');
  const total = chosen.reduce((n, p) => n + p.size, 0);
  const reserved = stored.reduce((n, p) => n + p.size, 0);
  // Failing here keeps the upload: the client may still abort it, or complete it without the condition.
  await checkWrite(ctx, account, bucket, key, condition);
  let obj: R2Object;
  try {
    obj = await ctx.env.BUCKET.resumeMultipartUpload(
      s3BlobKey(account.userId, up.blob_id),
      up.r2_upload_id,
    ).complete(chosen.map((p) => ({ partNumber: p.part_number, etag: p.etag })));
  } catch (e) {
    throw fromR2(e);
  }
  const row: ObjectRow = {
    user_id: account.userId,
    bucket,
    key,
    blob_id: up.blob_id,
    size: total,
    etag: obj.etag,
    content_type: up.content_type,
    meta_json: up.meta_json,
    scan_status: total === 0 ? 'clean' : 'pending',
    sha256: null,
    modified_at: ctx.now(),
  };
  const { won, old } = await replaceRow(
    db,
    row,
    [
      db.prepare(`DELETE FROM s3_upload_parts WHERE upload_id = ?1`).bind(up.id),
      db.prepare(`DELETE FROM s3_uploads WHERE id = ?1`).bind(up.id),
    ],
    condition,
  );
  if (!won) {
    // Another write landed while R2 joined the parts. R2 has used the upload up, so it goes, and
    // the client starts again (what Amazon's 409 means for a multipart upload).
    await releaseBytes(ctx, account.userId, reserved);
    await dropBlob(ctx, account.userId, up.blob_id);
    throw new S3Error(
      'ConditionalRequestConflict',
      'A conflicting operation occurred. Start a new multipart upload and try again.',
    );
  }
  await commitBytes(ctx, account.userId, reserved, total - (old?.size ?? 0));
  if (old) await dropBlob(ctx, account.userId, old.blob_id);
  await scanRequest(ctx, row);
  return row;
}

export async function abortUpload(
  ctx: Ctx,
  account: Pick<S3Account, 'userId' | 'indexBinding'>,
  bucket: string,
  key: string | null,
  uploadId: string,
): Promise<void> {
  const db = await indexDb(ctx.env, account.indexBinding);
  const up = await findUpload(db, account.userId, bucket, key, uploadId);
  await dropUpload(ctx, db, up);
}

/** Aborts an unfinished multipart upload in R2 and gives its reserved storage back. */
export async function dropUpload(ctx: Ctx, db: D1Database, up: UploadRow): Promise<void> {
  try {
    await ctx.env.BUCKET.resumeMultipartUpload(
      s3BlobKey(up.user_id, up.blob_id),
      up.r2_upload_id,
    ).abort();
  } catch {
    // Already gone in R2 (completed elsewhere, or auto-aborted after 7 days).
  }
  const [, parts] = await db.batch([
    db.prepare(`DELETE FROM s3_uploads WHERE id = ?1`).bind(up.id),
    db.prepare(`DELETE FROM s3_upload_parts WHERE upload_id = ?1 RETURNING size`).bind(up.id),
  ]);
  const reserved =
    (parts?.results as Array<{ size: number }> | undefined)?.reduce((n, p) => n + p.size, 0) ?? 0;
  await releaseBytes(ctx, up.user_id, reserved);
}

export async function listParts(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  uploadId: string,
  marker: number,
  max: number,
): Promise<{ upload: UploadRow; parts: PartRow[]; truncated: boolean }> {
  const db = await indexDb(ctx.env, account.indexBinding);
  const upload = await findUpload(db, account.userId, bucket, key, uploadId);
  const { results } = await db
    .prepare(
      `SELECT part_number, etag, size, created_at FROM s3_upload_parts WHERE upload_id = ?1 AND part_number > ?2
       ORDER BY part_number LIMIT ?3`,
    )
    .bind(upload.id, marker, max + 1)
    .all<PartRow>();
  return { upload, parts: results.slice(0, max), truncated: results.length > max };
}

export async function listUploads(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  prefix: string,
  keyMarker: string,
  max: number,
): Promise<{ uploads: UploadRow[]; truncated: boolean }> {
  const db = await indexDb(ctx.env, account.indexBinding);
  const upper = prefix ? prefixEnd(prefix) : null;
  const stmt = db.prepare(
    `SELECT * FROM s3_uploads WHERE bucket = ?1 AND user_id = ?2 AND key >= ?3 AND key > ?4` +
      (upper ? ` AND key < ?6` : '') +
      ` ORDER BY key, created_at LIMIT ?5`,
  );
  const { results } = await (
    upper
      ? stmt.bind(bucket, account.userId, prefix, keyMarker, max + 1, upper)
      : stmt.bind(bucket, account.userId, prefix, keyMarker, max + 1)
  ).all<UploadRow>();
  return { uploads: results.slice(0, max), truncated: results.length > max };
}

// ───────────────────────────── upkeep ─────────────────────────────

/**
 * Hourly: drops multipart uploads past `s3_multipart_ttl_hours` and gives their storage back. The
 * main index in one go; accounts with their own index a few at a time, oldest sweep first (Workers
 * Free allows 50 D1 queries per run).
 */
export async function expireS3Uploads(ctx: Ctx, accountsPerRun = 5): Promise<number> {
  const now = ctx.now();
  let n = 0;
  const sweep = async (db: D1Database, userId: string | null) => {
    const { results } = await (
      userId
        ? db
            .prepare(`SELECT * FROM s3_uploads WHERE expires_at < ?1 AND user_id = ?2 LIMIT 20`)
            .bind(now, userId)
        : db.prepare(`SELECT * FROM s3_uploads WHERE expires_at < ?1 LIMIT 20`).bind(now)
    ).all<UploadRow>();
    for (const up of results) {
      await dropUpload(ctx, db, up);
      n++;
    }
  };
  const anyShared = await ctx.env.DB.prepare(
    `SELECT 1 AS x FROM s3_accounts WHERE index_binding IS NULL LIMIT 1`,
  ).first<{ x: number }>();
  if (anyShared) await sweep(await indexDb(ctx.env, null), null);
  const { results: own } = await ctx.env.DB.prepare(
    `SELECT user_id, index_binding FROM s3_accounts WHERE index_binding IS NOT NULL ORDER BY swept_at LIMIT ?1`,
  )
    .bind(accountsPerRun)
    .all<{ user_id: string; index_binding: string }>();
  for (const a of own) {
    try {
      await sweep(await indexDb(ctx.env, a.index_binding), a.user_id);
    } catch (e) {
      log.warn('s3_sweep_failed', { userId: a.user_id, message: String(e) });
    }
    await ctx.env.DB.prepare(`UPDATE s3_accounts SET swept_at = ?2 WHERE user_id = ?1`)
      .bind(a.user_id, now)
      .run();
  }
  return n;
}

/** Nightly: storage recounted from the index (SPEC §4's reconciliation), mismatches reported. */
export async function reconcileS3(ctx: Ctx, limit = 20): Promise<number> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT user_id, used_bytes, index_binding FROM s3_accounts WHERE status != 'deleting'
     ORDER BY updated_at LIMIT ?1`,
  )
    .bind(limit)
    .all<{ user_id: string; used_bytes: number; index_binding: string | null }>();
  let fixed = 0;
  for (const a of results) {
    try {
      const db = await indexDb(ctx.env, a.index_binding);
      const sum = await db
        .prepare(`SELECT COALESCE(SUM(size), 0) AS s FROM s3_objects WHERE user_id = ?1`)
        .bind(a.user_id)
        .first<{ s: number }>();
      const actual = sum?.s ?? 0;
      await pruneBucketStats(ctx, db, a.user_id);
      if (actual !== a.used_bytes) {
        fixed++;
        log.warn('s3_usage_mismatch', { userId: a.user_id, stored: a.used_bytes, actual });
        await ctx.env.DB.prepare(
          `UPDATE s3_accounts SET used_bytes = ?2, updated_at = ?3 WHERE user_id = ?1`,
        )
          .bind(a.user_id, actual, ctx.now())
          .run();
      } else {
        await ctx.env.DB.prepare(`UPDATE s3_accounts SET updated_at = ?2 WHERE user_id = ?1`)
          .bind(a.user_id, ctx.now())
          .run();
      }
    } catch (e) {
      log.warn('s3_reconcile_failed', { userId: a.user_id, message: String(e) });
    }
  }
  if (fixed)
    await ctx.env.NOTIFY_QUEUE.send({
      type: 'admin_alert',
      text: `Zeiko S3: pemakaian ${fixed} akun tidak cocok dengan index dan sudah dihitung ulang.`,
    });
  return fixed;
}

/**
 * Deletes everything an account has in Zeiko S3, a batch at a time (account deletion, UU PDP).
 * Returns true once nothing is left and the account row is gone.
 */
export async function purgeS3Account(ctx: Ctx, userId: string, batches = 8): Promise<boolean> {
  const account = await getAccount(ctx, userId);
  if (!account) return true;
  // Its own address goes first, so it stops answering (ADR-048).
  await releaseS3Url(ctx, userId, 'deleted');
  const DB = ctx.env.DB;
  await DB.batch([
    DB.prepare(
      `UPDATE s3_accounts SET status = 'deleting', updated_at = ?2 WHERE user_id = ?1`,
    ).bind(userId, ctx.now()),
    DB.prepare(`DELETE FROM s3_keys WHERE user_id = ?1`).bind(userId),
  ]);
  const db = await indexDb(ctx.env, account.indexBinding);
  for (let i = 0; i < batches; i++) {
    const { results } = await db
      .prepare(`SELECT bucket, key, blob_id FROM s3_objects WHERE user_id = ?1 LIMIT 500`)
      .bind(userId)
      .all<{ bucket: string; key: string; blob_id: string }>();
    if (!results.length) break;
    const keys = results.map((r) => s3BlobKey(userId, r.blob_id));
    await ctx.env.BUCKET.delete(keys);
    await deleteReplicas(ctx.env, keys);
    await db.batch(
      results.map((r) =>
        db
          .prepare(`DELETE FROM s3_objects WHERE bucket = ?1 AND key = ?2 AND user_id = ?3`)
          .bind(r.bucket, r.key, userId),
      ),
    );
  }
  const { results: ups } = await db
    .prepare(`SELECT * FROM s3_uploads WHERE user_id = ?1 LIMIT 50`)
    .bind(userId)
    .all<UploadRow>();
  for (const up of ups) await dropUpload(ctx, db, up);
  const left = await db
    .prepare(
      `SELECT 1 AS x FROM s3_objects WHERE user_id = ?1 UNION ALL SELECT 1 FROM s3_uploads WHERE user_id = ?1 LIMIT 1`,
    )
    .bind(userId)
    .first<{ x: number }>();
  if (left) return false;
  await db.batch([
    db.prepare(`DELETE FROM s3_bucket_days WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM s3_log_lines WHERE user_id = ?1`).bind(userId),
  ]);
  await DB.batch([
    DB.prepare(`DELETE FROM s3_buckets WHERE user_id = ?1`).bind(userId),
    DB.prepare(`DELETE FROM s3_subscriptions WHERE user_id = ?1`).bind(userId),
    DB.prepare(`DELETE FROM s3_usage WHERE user_id = ?1`).bind(userId),
    DB.prepare(`DELETE FROM s3_accounts WHERE user_id = ?1`).bind(userId),
  ]);
  return true;
}

// ───────────────────────────── security scan ─────────────────────────────

/** Queue `scan`, `s3_scan` messages: the same scanner chain as Drive (SPEC §14.2). */
export async function processS3Scan(
  ctx: Ctx,
  msg: { userId: string; bucket: string; key: string; blobId: string; vt?: ScanCarry },
  attempts: number,
): Promise<'clean' | 'skipped' | 'infected' | 'error' | 'noop' | 'pending'> {
  const account = await getAccount(ctx, msg.userId);
  if (!account || account.status === 'deleting') return 'noop';
  const db = await indexDb(ctx.env, account.indexBinding);
  const row = await db
    .prepare(
      `SELECT * FROM s3_objects WHERE bucket = ?1 AND key = ?2 AND user_id = ?3 AND blob_id = ?4`,
    )
    .bind(msg.bucket, msg.key, msg.userId, msg.blobId)
    .first<ObjectRow>();
  // Replaced or deleted since: nothing to scan.
  if (!row || (row.scan_status !== 'pending' && row.scan_status !== 'error')) return 'noop';
  const cfg = await ctx.config();
  const r2Key = s3BlobKey(msg.userId, msg.blobId);
  const result: ScanResult = msg.vt
    ? msg.vt.base
    : await ctx.adapters.scanner.scan({
        key: r2Key,
        size: row.size,
        maxScanBytes: cfg.scan_max_bytes,
      });
  const same = `bucket = ?1 AND key = ?2 AND user_id = ?3 AND blob_id = ?4`;
  if (result.status === 'error') {
    if (attempts >= cfg.scan_max_attempts) {
      await db
        .prepare(`UPDATE s3_objects SET scan_status = 'error' WHERE ${same}`)
        .bind(msg.bucket, msg.key, msg.userId, msg.blobId)
        .run();
      await ctx.env.NOTIFY_QUEUE.send({
        type: 'admin_alert',
        text: `Scan Zeiko S3 gagal ${attempts}× untuk ${msg.bucket}/${msg.key}: ${result.detail ?? ''}`,
      });
      return 'error';
    }
    throw new Error(result.detail ?? 'scan error');
  }
  let status = result.status;
  let detail = result.detail;
  if (result.sha256) {
    const blocked = await ctx.env.DB.prepare('SELECT reason FROM blocked_hashes WHERE sha256 = ?1')
      .bind(result.sha256)
      .first<{ reason: string }>();
    if (blocked) {
      status = 'infected';
      detail = `blocked hash: ${blocked.reason}`;
    }
  }
  if ((status === 'clean' || status === 'skipped') && result.sha256) {
    const vt = await afterVirusTotal(
      ctx,
      {
        userId: msg.userId,
        sha256: result.sha256,
        size: row.size,
        name: msg.key,
        sniffedMime: result.sniffedMime,
        r2Key,
      },
      { ...result, status, sha256: result.sha256 },
      msg.vt,
      (vt, delaySeconds) =>
        ctx.env.SCAN_QUEUE.send(
          {
            type: 's3_scan',
            userId: msg.userId,
            bucket: msg.bucket,
            key: msg.key,
            blobId: msg.blobId,
            vt,
          },
          { delaySeconds },
        ),
    );
    if (vt === 'wait') return 'pending';
    ({ status, detail } = vt);
  }
  if (status !== 'infected') {
    await db
      .prepare(`UPDATE s3_objects SET scan_status = ?5, sha256 = ?6 WHERE ${same}`)
      .bind(msg.bucket, msg.key, msg.userId, msg.blobId, status, result.sha256)
      .run();
    // Passed: a 3-copy plan's other two copies (ADR-047).
    await replicateObject(ctx, account, row);
    return status;
  }
  const gone = await db
    .prepare(`DELETE FROM s3_objects WHERE ${same} RETURNING size`)
    .bind(msg.bucket, msg.key, msg.userId, msg.blobId)
    .first<{ size: number }>();
  if (gone) await commitBytes(ctx, msg.userId, 0, -gone.size);
  await dropBlob(ctx, msg.userId, msg.blobId);
  if (result.sha256) {
    await ctx.env.DB.prepare(
      `INSERT INTO blocked_hashes (sha256, reason, created_by, created_at) VALUES (?1, ?2, 'scanner', ?3)
       ON CONFLICT (sha256) DO NOTHING`,
    )
      .bind(result.sha256, detail ?? 'malware', ctx.now())
      .run();
  }
  await notify(ctx, msg.userId, 'file_rejected', {
    name: `${msg.bucket}/${msg.key}`,
    reason: detail,
    s3: true,
  });
  log.warn('s3_scan_infected', { userId: msg.userId, detail });
  return 'infected';
}
