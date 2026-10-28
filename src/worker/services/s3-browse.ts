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
  deleteObjects,
  getObjectRow,
  listObjects,
  putObject,
  validateKey,
  type ListCursor,
} from './s3-objects';

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
): Promise<{ url: string; expiresAt: number; keyId: string }> {
  readable(account);
  await ownBucket(ctx, account.userId, bucket);
  validateKey(key);
  if (!(await getObjectRow(ctx, account, bucket, key)))
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
  if (download) {
    const name = key.slice(key.lastIndexOf('/') + 1) || key;
    // AWS encoding (%20), not URLSearchParams' "+": S3 query values read "+" as a plus sign.
    url.search = `?response-content-disposition=${awsEncode(contentDisposition(name), false)}`;
  }
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
