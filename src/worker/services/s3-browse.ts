// The /s3 page's own view of a bucket (ADR-055): list one folder level, a time-limited link to an
// object (an ordinary presigned URL, signed with an access key of the account that may read it), delete, and
// upload a file through the app. Everything here is the signed-in owner's, through /api/s3.
import type { Ctx } from '../context';
import { contentDisposition } from '../lib/http';
import { AppError } from '../lib/errors';
import { awsEncode, presignUrl } from '../lib/s3-sigv4';
import { base64UrlDecode, base64UrlEncode } from '../lib/crypto';
import { listKeys, lookupKey, ownBucket, S3_REGION, type S3Account } from './s3';
import {
  abortUpload,
  completeUpload,
  createUpload,
  deleteObjects,
  getObjectRow,
  listObjects,
  listParts,
  putObject,
  uploadPart,
  validateKey,
  copyObject,
  deleteVersion,
  type ListCursor,
} from './s3-objects';
import { indexDb } from './s3-index';
import {
  getVersionRow,
  listObjectVersions,
  setBucketVersioning,
  versioningOf,
  type Versioning,
} from './s3-versions';

export interface BrowseResult {
  prefix: string;
  /** Sub-folders ("foto/2024/"). */
  prefixes: string[];
  objects: Array<{ key: string; size: number; etag: string; modifiedAt: number }>;
  nextCursor: string | null;
}

const encodeCursor = (c: ListCursor) =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(c)));

function decodeCursor(s: string): ListCursor {
  try {
    const v = JSON.parse(new TextDecoder().decode(base64UrlDecode(s))) as Record<string, unknown>;
    if (typeof v.after === 'string') return { after: v.after };
    if (typeof v.skip === 'string') return { skip: v.skip };
  } catch {
    // fall through
  }
  throw new AppError('VALIDATION', 'bad cursor', { field: 'cursor' });
}

function readable(account: S3Account): void {
  if (account.billingState === 'locked')
    throw new AppError('FORBIDDEN', 'this Zeiko S3 account is locked until its bill is paid', {
      reason: 's3_locked',
    });
}

function writable(account: S3Account): void {
  readable(account);
  if (account.billingState === 'readonly')
    throw new AppError('FORBIDDEN', 'uploads are paused until the Zeiko S3 bill is paid', {
      reason: 's3_readonly',
    });
}

export async function browseObjects(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  prefix: string,
  cursor: string | null,
  max = 200,
): Promise<BrowseResult> {
  readable(account);
  await ownBucket(ctx, account.userId, bucket);
  const res = await listObjects(ctx, account, bucket, {
    prefix,
    delimiter: '/',
    maxKeys: max,
    ...(cursor ? { cursor: decodeCursor(cursor) } : {}),
  });
  return {
    prefix,
    prefixes: res.prefixes,
    // A "folder" made in the app is a zero-byte key ending in "/": shown as the folder only.
    objects: res.contents
      .filter((o) => o.key !== prefix)
      .map((o) => ({ key: o.key, size: o.size, etag: o.etag, modifiedAt: o.modified_at })),
    nextCursor: res.truncated && res.next ? encodeCursor(res.next) : null,
  };
}

/**
 * The key a link to this object is signed with (ADR-071): one whose scope may read it, never-expiring
 * keys first, then the one that lasts longest, then the newest. A link can't outlive its key.
 */
async function signingKeyOf(
  ctx: Ctx,
  userId: string,
  bucket: string,
  objectKey: string,
): Promise<{ id: string; secret: string; expiresAt: number | null }> {
  const now = ctx.now();
  const usable = (await listKeys(ctx, userId))
    .filter((k) => k.access !== 'w' && (k.expiresAt === null || k.expiresAt > now + 60_000))
    .filter((k) => !k.buckets || k.buckets.includes(bucket))
    .filter((k) => k.prefix === null || objectKey.startsWith(k.prefix))
    .sort(
      (a, b) => (b.expiresAt ?? Infinity) - (a.expiresAt ?? Infinity) || b.createdAt - a.createdAt,
    );
  for (const k of usable) {
    const found = await lookupKey(ctx, k.id);
    if (found && !found.revoked) return { id: k.id, secret: found.secret, expiresAt: k.expiresAt };
  }
  throw new AppError('CONFLICT', 'make an access key that may read this object first', {
    reason: 's3_no_key',
  });
}

export async function objectLink(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  expiresSeconds: number,
  download: boolean,
  /** ADR-092: a link to that version (signed with it, so it can't be changed into another). */
  versionId?: string,
): Promise<{ url: string; expiresAt: number; keyId: string }> {
  readable(account);
  await ownBucket(ctx, account.userId, bucket);
  validateKey(key);
  if (versionId) {
    const db = await indexDb(ctx.env, account.indexBinding);
    const v = await getVersionRow(db, account.userId, bucket, key, versionId);
    if (!v || v.delete_marker) throw new AppError('NOT_FOUND', 'no such version');
  } else if (!(await getObjectRow(ctx, account, bucket, key)))
    throw new AppError('NOT_FOUND', 'no such object');
  if (!ctx.env.S3_ORIGIN) throw new AppError('FORBIDDEN', 'Zeiko S3 is not available');
  const cfg = await ctx.config();
  const signer = await signingKeyOf(ctx, account.userId, bucket, key);
  const keyLeft =
    signer.expiresAt === null ? Infinity : Math.floor((signer.expiresAt - ctx.now()) / 1000);
  const seconds = Math.max(
    60,
    Math.min(cfg.s3_link_max_seconds, keyLeft, Math.floor(expiresSeconds)),
  );
  const url = new URL(`${ctx.env.S3_ORIGIN}/${awsEncode(bucket, false)}/${awsEncode(key, true)}`);
  const params: string[] = [];
  if (download) {
    const name = key.slice(key.lastIndexOf('/') + 1) || key;
    // AWS encoding (%20), not URLSearchParams' "+": S3 query values read "+" as a plus sign.
    params.push(`response-content-disposition=${awsEncode(contentDisposition(name), false)}`);
  }
  if (versionId) params.push(`versionId=${awsEncode(versionId, false)}`);
  if (params.length) url.search = `?${params.join('&')}`;
  const now = Date.now();
  return {
    url: await presignUrl({
      method: 'GET',
      url,
      accessKeyId: signer.id,
      secret: signer.secret,
      region: S3_REGION,
      now,
      expiresSeconds: seconds,
    }),
    expiresAt: now + seconds * 1000,
    keyId: signer.id,
  };
}

export async function deleteKeys(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  keys: string[],
): Promise<number> {
  readable(account);
  await ownBucket(ctx, account.userId, bucket);
  const unique = [...new Set(keys)];
  for (const k of unique) validateKey(k);
  await deleteObjects(ctx, account, bucket, unique);
  return unique.length;
}

/** One request, so the Workers body cap applies: bigger files need an S3 client (multipart). */
export async function uploadObject(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  size: number | null,
  contentType: string | null,
  body: ReadableStream<Uint8Array> | null,
) {
  writable(account);
  await ownBucket(ctx, account.userId, bucket);
  const cfg = await ctx.config();
  if (size === null) throw new AppError('VALIDATION', 'Content-Length is required');
  if (size > cfg.s3_web_upload_max_bytes)
    throw new AppError('PAYLOAD_TOO_LARGE', 'too big to upload from the page', {
      max: cfg.s3_web_upload_max_bytes,
    });
  const row = await putObject(ctx, account, {
    bucket,
    key,
    body,
    size,
    contentType: contentType && contentType !== 'application/octet-stream' ? contentType : null,
    meta: {},
  });
  return { key: row.key, size: row.size, etag: row.etag, modifiedAt: row.modified_at };
}

// ── Files bigger than one request, in parts through the app (S4, ADR-075) ──
// The page never talks to the S3 host, so it needs no CORS on the bucket and no key: each part is
// one request to /api/s3, on the same multipart upload an S3 client would make.

const MAX_PARTS = 10_000;
const MIB = 1024 * 1024;

/** The part size for a file: the config's, raised (to whole MiB) when it would take too many parts. */
export function webPartSize(size: number, partBytes: number, requestMax: number): number {
  const needed = Math.ceil(size / MAX_PARTS / MIB) * MIB;
  return Math.min(Math.max(partBytes, needed), requestMax);
}

export async function startWebUpload(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  size: number,
  contentType: string | null,
): Promise<{ uploadId: string; partSize: number; parts: number }> {
  writable(account);
  await ownBucket(ctx, account.userId, bucket);
  validateKey(key);
  const cfg = await ctx.config();
  if (size > cfg.s3_web_multipart_max_bytes)
    throw new AppError('PAYLOAD_TOO_LARGE', 'too big to upload from the page', {
      max: cfg.s3_web_multipart_max_bytes,
    });
  const partSize = webPartSize(size, cfg.s3_web_part_bytes, cfg.s3_web_upload_max_bytes);
  const parts = Math.max(1, Math.ceil(size / partSize));
  if (parts > MAX_PARTS)
    throw new AppError('PAYLOAD_TOO_LARGE', 'too many parts', { max: partSize * MAX_PARTS });
  const up = await createUpload(
    ctx,
    account,
    bucket,
    key,
    contentType && contentType !== 'application/octet-stream' ? contentType : null,
    {},
  );
  return { uploadId: up.id, partSize, parts };
}

export async function sendWebPart(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  size: number | null,
  body: ReadableStream<Uint8Array> | null,
): Promise<{ etag: string }> {
  writable(account);
  await ownBucket(ctx, account.userId, bucket);
  const cfg = await ctx.config();
  if (size === null) throw new AppError('VALIDATION', 'Content-Length is required');
  if (size > cfg.s3_web_upload_max_bytes)
    throw new AppError('PAYLOAD_TOO_LARGE', 'part too big', { max: cfg.s3_web_upload_max_bytes });
  const etag = await uploadPart(ctx, account, bucket, key, uploadId, partNumber, body, size);
  return { etag };
}

/** The parts already stored, so a paused or broken upload carries on where it was. */
export async function webUploadParts(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  uploadId: string,
): Promise<Array<{ partNumber: number; etag: string; size: number }>> {
  readable(account);
  await ownBucket(ctx, account.userId, bucket);
  const out: Array<{ partNumber: number; etag: string; size: number }> = [];
  for (let marker = 0; ;) {
    const page = await listParts(ctx, account, bucket, key, uploadId, marker, 1000);
    for (const p of page.parts) out.push({ partNumber: p.part_number, etag: p.etag, size: p.size });
    if (!page.truncated || !page.parts.length) return out;
    marker = page.parts[page.parts.length - 1]!.part_number;
  }
}

export async function finishWebUpload(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
) {
  writable(account);
  await ownBucket(ctx, account.userId, bucket);
  const row = await completeUpload(ctx, account, bucket, key, uploadId, parts);
  return { key: row.key, size: row.size, etag: row.etag, modifiedAt: row.modified_at };
}

export async function cancelWebUpload(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  uploadId: string,
): Promise<void> {
  readable(account);
  await ownBucket(ctx, account.userId, bucket);
  await abortUpload(ctx, account, bucket, key, uploadId);
}

// ───────────────────────────── versions (ADR-092) ─────────────────────────────

export interface WebVersion {
  versionId: string;
  isLatest: boolean;
  deleteMarker: boolean;
  size: number;
  modifiedAt: number;
  /** Object Lock on this version, if any. */
  lock: {
    mode: 'GOVERNANCE' | 'COMPLIANCE' | null;
    until: number | null;
    legalHold: boolean;
  } | null;
}

/** Every version of one object (newest first), for the page's Versions panel. */
export async function objectVersions(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
): Promise<{ versioning: Versioning; versions: WebVersion[] }> {
  readable(account);
  const b = await ownBucket(ctx, account.userId, bucket);
  validateKey(key);
  const res = await listObjectVersions(ctx, account, bucket, {
    prefix: key,
    delimiter: '',
    maxKeys: 200,
  });
  const db = await indexDb(ctx.env, account.indexBinding);
  const versions: WebVersion[] = [];
  for (const v of res.versions.filter((x) => x.key === key)) {
    let lock: WebVersion['lock'] = null;
    if (!v.deleteMarker) {
      const row = await getVersionRow(db, account.userId, bucket, key, v.versionId);
      if (row && (row.lock_until || row.legal_hold))
        lock = {
          mode: row.lock_mode ?? null,
          until: row.lock_until ?? null,
          legalHold: Boolean(row.legal_hold),
        };
    }
    versions.push({
      versionId: v.versionId,
      isLatest: v.isLatest,
      deleteMarker: v.deleteMarker,
      size: v.size,
      modifiedAt: v.modifiedAt,
      lock,
    });
  }
  return { versioning: versioningOf(b), versions };
}

/** Objects in one folder level whose latest version is a delete marker (they can be brought back). */
export async function deletedObjects(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  prefix: string,
): Promise<Array<{ key: string; deletedAt: number; markerId: string }>> {
  readable(account);
  await ownBucket(ctx, account.userId, bucket);
  const db = await indexDb(ctx.env, account.indexBinding);
  const { results } = await db
    .prepare(
      `SELECT key, version_id, modified_at FROM s3_versions
       WHERE bucket = ?1 AND user_id = ?2 AND key >= ?3 AND substr(key, 1, length(?3)) = ?3
         AND delete_marker = 1 AND noncurrent_at IS NULL
         AND instr(substr(key, length(?3) + 1), '/') = 0
       ORDER BY key LIMIT 200`,
    )
    .bind(bucket, account.userId, prefix)
    .all<{ key: string; version_id: string; modified_at: number }>();
  return results.map((r) => ({ key: r.key, deletedAt: r.modified_at, markerId: r.version_id }));
}

/**
 * Brings a version back: a delete marker that is the latest goes (the version before it shows
 * again); an older version is copied to be the newest, as the S3 console does.
 */
export async function restoreVersion(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  versionId: string,
): Promise<void> {
  writable(account);
  const b = await ownBucket(ctx, account.userId, bucket);
  validateKey(key);
  const db = await indexDb(ctx.env, account.indexBinding);
  const v = await getVersionRow(db, account.userId, bucket, key, versionId);
  if (!v) throw new AppError('NOT_FOUND', 'no such version');
  if (v.delete_marker) {
    if (v.is_latest) await deleteVersion(ctx, account, bucket, key, versionId);
    return;
  }
  if (v.is_latest) return;
  await copyObject(ctx, account, {
    from: { bucket, key, versionId },
    to: { bucket, key },
    replace: false,
    contentType: null,
    meta: {},
    versioning: versioningOf(b),
  });
}

/** Removes one version for good (Object Lock may refuse). */
export async function removeVersion(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  key: string,
  versionId: string,
): Promise<void> {
  readable(account);
  await ownBucket(ctx, account.userId, bucket);
  validateKey(key);
  await deleteVersion(ctx, account, bucket, key, versionId);
}

export async function setVersioningFromApp(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  status: 'Enabled' | 'Suspended',
): Promise<void> {
  writable(account);
  await setBucketVersioning(ctx, account.userId, bucket, status);
}
