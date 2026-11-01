// Zeiko S3 versioning (ADR-092, S5). A bucket is unversioned (never turned on), Enabled or
// Suspended, as on Amazon. `s3_objects` holds each key's current version; `s3_versions` holds the
// older ones and the delete markers. Every write and delete that touches versions is one D1 batch
// (one transaction), so a key always has exactly one latest version: its `s3_objects` row, or, when
// it has none, the delete marker in `s3_versions` with `noncurrent_at IS NULL`.
// Older versions keep their bytes, so they count toward the account's storage and bill (the
// owner's answer, ADR-092).
import { DAY_MS } from '../../shared/constants';
import type { Ctx } from '../context';
import { ulid } from '../lib/ids';
import { S3Error } from '../lib/s3-errors';
import { ownBucket, type BucketRow, type S3Account } from './s3';
import { indexDb } from './s3-index';
import type { ObjectRow } from './s3-objects';

export type Versioning = '' | 'Enabled' | 'Suspended';

/** The columns a version has in both tables (besides its id). */
export const OBJ_COLS =
  'user_id, bucket, key, blob_id, size, etag, content_type, meta_json, scan_status, sha256, ' +
  'modified_at, tags_json, parts, part_size, checksum_json, replicated, lock_mode, lock_until, legal_hold';

export interface VersionRow extends ObjectRow {
  version_id: string;
  delete_marker: number;
  /** Null for the current version and for a delete marker that is the latest. */
  noncurrent_at: number | null;
  is_latest: boolean;
}

export const versioningOf = (b: Pick<BucketRow, 'versioning'>): Versioning =>
  b.versioning === 'Enabled' || b.versioning === 'Suspended' ? b.versioning : '';

/** The id a new version gets: a fresh one while versioning is on, the "null" version otherwise. */
export function nextVersionId(mode: Versioning, now: number): string | null {
  return mode === 'Enabled' ? ulid(now) : null;
}

/** What the API says a row's version is ("null" for the null version). */
export const versionIdOf = (row: Pick<ObjectRow, 'version_id'>) => row.version_id ?? 'null';

/**
 * Why Object Lock keeps a version (ADR-092), or null: a legal hold, a COMPLIANCE retention that
 * hasn't ended, or a GOVERNANCE one unless the request may and does bypass it.
 */
export function lockBlocks(
  row: Pick<ObjectRow, 'lock_mode' | 'lock_until' | 'legal_hold'>,
  now: number,
  bypassGovernance: boolean,
): 'legal-hold' | 'COMPLIANCE' | 'GOVERNANCE' | null {
  if (row.legal_hold) return 'legal-hold';
  if (row.lock_until && row.lock_until > now) {
    if (row.lock_mode === 'COMPLIANCE') return 'COMPLIANCE';
    if (row.lock_mode === 'GOVERNANCE' && !bypassGovernance) return 'GOVERNANCE';
  }
  return null;
}

/** Our ids (ULIDs) and "null"; anything else is not a version Zeiko S3 could have made. */
export function checkVersionId(v: string): string {
  if (v === 'null' || /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v)) return v;
  throw new S3Error('InvalidArgument', 'Invalid version id specified', {
    ArgumentName: 'versionId',
    ArgumentValue: v,
  });
}

/** Whether (and how) the bucket keeps versions; the bucket must be the account's own. */
export async function bucketVersioning(
  ctx: Ctx,
  userId: string,
  bucket: string,
): Promise<Versioning> {
  return versioningOf(await ownBucket(ctx, userId, bucket));
}

/** PutBucketVersioning. A bucket with Object Lock can't be suspended (Amazon's rule). */
export async function setBucketVersioning(
  ctx: Ctx,
  userId: string,
  bucket: string,
  status: 'Enabled' | 'Suspended',
): Promise<void> {
  const b = await ownBucket(ctx, userId, bucket);
  if (status === 'Suspended' && b.object_lock_json)
    throw new S3Error(
      'InvalidBucketState',
      'An Object Lock configuration is present on this bucket, so the versioning state cannot be changed.',
    );
  await ctx.env.DB.prepare(`UPDATE s3_buckets SET versioning = ?3 WHERE name = ?1 AND user_id = ?2`)
    .bind(bucket, userId, status)
    .run();
}

// ───────────────────────────── Object Lock ─────────────────────────────

export type LockMode = 'GOVERNANCE' | 'COMPLIANCE';

/** A bucket's Object Lock (ADR-092): on, and the retention new objects get by default, if any. */
export interface ObjectLockConfig {
  mode: LockMode | null;
  days?: number;
  years?: number;
}

/** The lock a new version gets. */
export interface WriteLock {
  mode: LockMode | null;
  until: number | null;
  legalHold: boolean;
}

export function objectLockOf(b: Pick<BucketRow, 'object_lock_json'>): ObjectLockConfig | null {
  if (!b.object_lock_json) return null;
  try {
    return JSON.parse(b.object_lock_json) as ObjectLockConfig;
  } catch {
    return null;
  }
}

/** `until` for a retention of `days` or `years` from `now` (years on the calendar, UTC). */
export function retentionUntil(now: number, c: Pick<ObjectLockConfig, 'days' | 'years'>): number {
  if (c.years) {
    const d = new Date(now);
    d.setUTCFullYear(d.getUTCFullYear() + c.years);
    return d.getTime();
  }
  return now + (c.days ?? 0) * DAY_MS;
}

/** What a new version gets when the request names no lock: the bucket's default, if any. */
export function defaultLock(b: Pick<BucketRow, 'object_lock_json'>, now: number): WriteLock | null {
  const c = objectLockOf(b);
  if (!c?.mode) return null;
  return { mode: c.mode, until: retentionUntil(now, c), legalHold: false };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** A RetainUntilDate as Amazon takes it (ISO 8601), in the future. */
export function parseRetainUntil(v: string, now: number): number {
  const t = ISO.test(v.trim()) ? Date.parse(v.trim()) : NaN;
  if (Number.isNaN(t))
    throw new S3Error('InvalidArgument', 'The retain until date is not a valid date.');
  if (t <= now)
    throw new S3Error('InvalidArgument', 'The retain until date must be in the future!');
  return t;
}

export function parseLockMode(v: string | null): LockMode {
  if (v === 'GOVERNANCE' || v === 'COMPLIANCE') return v;
  throw new S3Error('InvalidArgument', 'Unknown Object Lock mode; use GOVERNANCE or COMPLIANCE.');
}

/**
 * x-amz-object-lock-mode / -retain-until-date / -legal-hold on a write, or the bucket's default.
 * Asking for a lock in a bucket without Object Lock is refused, not ignored.
 */
export function lockFromHeaders(
  h: Headers,
  b: Pick<BucketRow, 'object_lock_json'>,
  now: number,
): WriteLock | null {
  const mode = h.get('x-amz-object-lock-mode');
  const until = h.get('x-amz-object-lock-retain-until-date');
  const hold = h.get('x-amz-object-lock-legal-hold');
  if (mode === null && until === null && hold === null) return defaultLock(b, now);
  if (!objectLockOf(b))
    throw new S3Error('InvalidRequest', 'Bucket is missing Object Lock Configuration');
  if ((mode === null) !== (until === null))
    throw new S3Error(
      'InvalidArgument',
      'x-amz-object-lock-retain-until-date and x-amz-object-lock-mode must both be supplied',
    );
  if (hold !== null && hold !== 'ON' && hold !== 'OFF')
    throw new S3Error('InvalidArgument', 'Legal Hold must be either of ON or OFF');
  const base = mode === null ? defaultLock(b, now) : null;
  return {
    mode: mode === null ? (base?.mode ?? null) : parseLockMode(mode),
    until: until === null ? (base?.until ?? null) : parseRetainUntil(until, now),
    legalHold: hold === 'ON',
  };
}

/** PutObjectLockConfiguration: turns Object Lock on (versioning must be on) and sets the default. */
export async function setObjectLockConfig(
  ctx: Ctx,
  userId: string,
  bucket: string,
  config: ObjectLockConfig,
): Promise<void> {
  const b = await ownBucket(ctx, userId, bucket);
  if (!objectLockOf(b) && versioningOf(b) !== 'Enabled')
    throw new S3Error(
      'InvalidBucketState',
      'Versioning must be Enabled on the bucket to apply an Object Lock configuration.',
    );
  await ctx.env.DB.prepare(
    `UPDATE s3_buckets SET object_lock_json = ?3, versioning = 'Enabled' WHERE name = ?1 AND user_id = ?2`,
  )
    .bind(bucket, userId, JSON.stringify(config))
    .run();
}

const NAME = 'bucket = ?1 AND key = ?2 AND user_id = ?3';

/**
 * Moves the current version of one key into `s3_versions` (as of `now`, ?4). `nullToo` false
 * leaves the null version where it is (Suspended: a new null version replaces it instead).
 * `etag` (?5) only moves it while it still has that ETag (If-Match).
 */
export function archiveCurrent(
  db: D1Database,
  row: Pick<ObjectRow, 'bucket' | 'key' | 'user_id'>,
  now: number,
  nullToo: boolean,
  etag?: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO s3_versions (version_id, delete_marker, noncurrent_at, ${OBJ_COLS})
       SELECT COALESCE(version_id, 'null'), 0, ?4, ${OBJ_COLS} FROM s3_objects
       WHERE ${NAME}${nullToo ? '' : ' AND version_id IS NOT NULL'}${etag === undefined ? '' : ' AND etag = ?5'}`,
    )
    .bind(row.bucket, row.key, row.user_id, now, ...(etag === undefined ? [] : [etag]));
}

/**
 * A delete marker that was the latest of its key stops being the latest. `guard` adds a
 * condition (e.g. only while the key has no current version).
 */
export function retireMarker(
  db: D1Database,
  row: Pick<ObjectRow, 'bucket' | 'key' | 'user_id'>,
  now: number,
  guard = '',
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE s3_versions SET noncurrent_at = ?4 WHERE ${NAME} AND noncurrent_at IS NULL${guard}`,
    )
    .bind(row.bucket, row.key, row.user_id, now);
}

/** Suspended: the older null version (or null delete marker) goes, its bytes with it. */
export function dropNullVersion(
  db: D1Database,
  row: Pick<ObjectRow, 'bucket' | 'key' | 'user_id'>,
  guard = '',
  ...extra: unknown[]
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM s3_versions WHERE ${NAME} AND version_id = 'null'${guard}
       RETURNING blob_id, size, delete_marker`,
    )
    .bind(row.bucket, row.key, row.user_id, ...extra);
}

/** `WHERE` text: the key has no current version. */
export const NO_CURRENT = ` AND NOT EXISTS (SELECT 1 FROM s3_objects o WHERE o.bucket = ?1 AND o.key = ?2)`;

const NEWER = (t: string) =>
  `EXISTS (SELECT 1 FROM s3_versions w WHERE w.bucket = ?1 AND w.key = ?2
     AND (w.modified_at > ${t}.modified_at OR (w.modified_at = ${t}.modified_at AND w.version_id > ${t}.version_id)))`;

/**
 * After the latest version of a key was removed for good: the newest one left becomes the latest.
 * An object version moves back into `s3_objects`; a delete marker just becomes the latest marker.
 */
export function promoteNewest(
  db: D1Database,
  bucket: string,
  key: string,
  userId: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO s3_objects (version_id, ${OBJ_COLS})
         SELECT NULLIF(version_id, 'null'), ${OBJ_COLS} FROM s3_versions v
         WHERE v.bucket = ?1 AND v.key = ?2 AND v.user_id = ?3 AND v.delete_marker = 0
           ${NO_CURRENT} AND NOT ${NEWER('v')}`,
      )
      .bind(bucket, key, userId),
    db
      .prepare(
        `DELETE FROM s3_versions WHERE ${NAME} AND delete_marker = 0
           AND version_id = (SELECT COALESCE(version_id, 'null') FROM s3_objects o WHERE o.bucket = ?1 AND o.key = ?2)`,
      )
      .bind(bucket, key, userId),
    db
      .prepare(
        `UPDATE s3_versions SET noncurrent_at = NULL
         WHERE ${NAME} AND delete_marker = 1 AND noncurrent_at IS NOT NULL ${NO_CURRENT}
           AND NOT ${NEWER('s3_versions')}`,
      )
      .bind(bucket, key, userId),
  ];
}

/** One version of a key, current or not, delete markers included. */
export async function getVersionRow(
  db: D1Database,
  userId: string,
  bucket: string,
  key: string,
  versionId: string,
): Promise<VersionRow | null> {
  const [cur, old] = await db.batch([
    db
      .prepare(`SELECT * FROM s3_objects WHERE ${NAME} AND COALESCE(version_id, 'null') = ?4`)
      .bind(bucket, key, userId, versionId),
    db
      .prepare(`SELECT * FROM s3_versions WHERE ${NAME} AND version_id = ?4`)
      .bind(bucket, key, userId, versionId),
  ]);
  const c = cur?.results[0] as ObjectRow | undefined;
  if (c)
    return {
      ...c,
      version_id: versionIdOf(c),
      delete_marker: 0,
      noncurrent_at: null,
      is_latest: true,
    };
  const o = old?.results[0] as (Omit<VersionRow, 'is_latest'> & ObjectRow) | undefined;
  return o ? { ...o, is_latest: o.noncurrent_at === null } : null;
}

/** The delete marker that is a key's latest version, if that is what it has. */
export async function latestMarker(
  db: D1Database,
  userId: string,
  bucket: string,
  key: string,
): Promise<string | null> {
  const r = await db
    .prepare(
      `SELECT version_id FROM s3_versions WHERE ${NAME} AND delete_marker = 1 AND noncurrent_at IS NULL`,
    )
    .bind(bucket, key, userId)
    .first<{ version_id: string }>();
  return r?.version_id ?? null;
}

// ───────────────────────────── ListObjectVersions ─────────────────────────────

export interface VersionEntry {
  key: string;
  versionId: string;
  deleteMarker: boolean;
  isLatest: boolean;
  modifiedAt: number;
  etag: string;
  size: number;
}

export interface VersionListInput {
  prefix: string;
  delimiter: string;
  maxKeys: number;
  keyMarker?: string;
  versionIdMarker?: string;
}

export interface VersionListResult {
  versions: VersionEntry[];
  prefixes: string[];
  truncated: boolean;
  nextKeyMarker: string | null;
  nextVersionIdMarker: string | null;
}

interface ListedRow {
  key: string;
  vid: string;
  dm: number;
  latest: number;
  modified_at: number;
  etag: string;
  size: number;
}

/** The smallest string after every string that starts with `p` (UTF-8 order), or null. */
function prefixEnd(p: string): string | null {
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

/**
 * Every version of the bucket's keys: by key, then the latest first and older ones newest first
 * (Amazon's order), with common prefixes rolled up like ListObjects.
 */
export async function listObjectVersions(
  ctx: Ctx,
  account: Pick<S3Account, 'userId' | 'indexBinding'>,
  bucket: string,
  input: VersionListInput,
): Promise<VersionListResult> {
  const db = await indexDb(ctx.env, account.indexBinding);
  const cfg = await ctx.config();
  const { prefix, delimiter, maxKeys: max } = input;
  const out: VersionListResult = {
    versions: [],
    prefixes: [],
    truncated: false,
    nextKeyMarker: null,
    nextVersionIdMarker: null,
  };
  if (max <= 0) return out;
  const upper = prefix ? prefixEnd(prefix) : null;
  const keyMarker = input.keyMarker ?? '';
  // Where to start: after the marker's version within its key, or after the marker key.
  let from = '';
  let afterKey = keyMarker;
  let within: { key: string; latest: number; modified: number; vid: string } | null = null;
  if (keyMarker && input.versionIdMarker) {
    const m = await getVersionRow(db, account.userId, bucket, keyMarker, input.versionIdMarker);
    if (m)
      within = {
        key: keyMarker,
        latest: m.is_latest ? 1 : 0,
        modified: m.modified_at,
        vid: m.version_id,
      };
  }
  const part = (table: 's3_objects' | 's3_versions') =>
    table === 's3_objects'
      ? `SELECT key, COALESCE(version_id, 'null') AS vid, 0 AS dm, 1 AS latest, modified_at, etag, size
         FROM s3_objects WHERE bucket = ?1 AND user_id = ?2 AND key >= ?3 AND key >= ?4${upper ? ' AND key < ?6' : ''}`
      : `SELECT key, version_id AS vid, delete_marker AS dm, CASE WHEN noncurrent_at IS NULL THEN 1 ELSE 0 END AS latest,
           modified_at, etag, size
         FROM s3_versions WHERE bucket = ?1 AND user_id = ?2 AND key >= ?3 AND key >= ?4${upper ? ' AND key < ?6' : ''}`;
  let count = 0;
  let last: { key: string; vid: string } | null = null;
  for (let q = 0; q < cfg.s3_list_max_queries; q++) {
    const limit = Math.min(1000, max - count + 1);
    const sql =
      `SELECT * FROM (${part('s3_objects')} UNION ALL ${part('s3_versions')})
       WHERE ` +
      (within
        ? `(key > ?7 OR (key = ?7 AND (latest < ?8 OR (latest = ?8 AND (modified_at < ?9
             OR (modified_at = ?9 AND vid < ?10))))))`
        : `(?7 = '' OR key > ?7)`) +
      ` ORDER BY key, latest DESC, modified_at DESC, vid DESC LIMIT ?5`;
    // ?4: the first key that may come (after a common prefix); ?7: the marker, left out itself.
    const binds: unknown[] = [
      bucket,
      account.userId,
      prefix,
      from,
      limit,
      upper ?? '',
      within ? within.key : afterKey,
    ];
    if (within) binds.push(within.latest, within.modified, within.vid);
    const { results: rows } = await db
      .prepare(sql)
      .bind(...binds)
      .all<ListedRow>();
    let jumped = false;
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j]!;
      if (count >= max) {
        out.truncated = true;
        return out;
      }
      if (delimiter) {
        const i = r.key.indexOf(delimiter, prefix.length);
        if (i !== -1) {
          const cp = r.key.slice(0, i + delimiter.length);
          if (!(keyMarker && keyMarker.startsWith(cp))) {
            out.prefixes.push(cp);
            count++;
          }
          out.nextKeyMarker = cp;
          out.nextVersionIdMarker = null;
          last = null;
          const end = prefixEnd(cp);
          if (end === null) return out;
          from = end;
          afterKey = '';
          within = null;
          jumped = true;
          break;
        }
      }
      out.versions.push({
        key: r.key,
        versionId: r.vid,
        deleteMarker: r.dm === 1,
        isLatest: r.latest === 1,
        modifiedAt: r.modified_at,
        etag: r.etag,
        size: r.size,
      });
      count++;
      last = { key: r.key, vid: r.vid };
      out.nextKeyMarker = r.key;
      out.nextVersionIdMarker = r.vid;
    }
    if (!jumped) {
      if (rows.length < limit) {
        out.nextKeyMarker = null;
        out.nextVersionIdMarker = null;
        return out;
      }
      if (last) {
        const m = rows[rows.length - 1]!;
        within = { key: m.key, latest: m.latest, modified: m.modified_at, vid: m.vid };
      }
    }
  }
  out.truncated = true;
  return out;
}
