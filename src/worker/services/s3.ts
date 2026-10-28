// Zeiko S3 control plane (ADR-044): who may use the API (accounts, set up by the relay's operator),
// their access keys, their buckets and the storage each may fill. The objects themselves are in
// services/s3-objects.ts. A Zeiko S3 account is a Zeiko Drive user (signed in once with their Zeiko
// Account) with an `s3_accounts` row; its storage is separate from any Drive plan.
import type { Ctx } from '../context';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { aesGcmDecrypt, aesGcmEncrypt } from '../lib/crypto';
import { randomBase62, ulid } from '../lib/ids';
import { S3Error } from '../lib/s3-errors';
import { boundIndex, ensureIndex, INDEX_BINDING_RE, indexDb } from './s3-index';
import { s3PlanView, type S3BillingState } from './s3-billing';
import { s3UrlView, urlOptions } from './s3-urls';

export type S3AccountStatus = 'active' | 'suspended' | 'deleting';

export interface S3Account {
  userId: string;
  status: S3AccountStatus;
  limitBytes: number;
  usedBytes: number;
  reservedBytes: number;
  indexBinding: string | null;
  /** A plan not renewed (ADR-047): `readonly` takes no uploads, `locked` answers nothing. */
  billingState: S3BillingState;
  /** Copies kept of every object: 3 on a 3-copy plan (ADR-047). */
  replicas: number;
  /** The paid period reads are counted in; null without a plan (granted by the operator). */
  periodStart: number | null;
}

/** R2 key of an object's bytes: one folder per account (the owner's diagram). */
export function s3BlobKey(userId: string, blobId: string): string {
  return `s3/${userId}/${blobId}`;
}

/** The API answers only on its own host, and only once secret keys can be sealed. */
export function s3Configured(env: Env): boolean {
  return Boolean(env.S3_ORIGIN && env.S3_KEYS_ENC_KEY);
}

export const S3_REGION = 'auto';

async function audit(
  ctx: Ctx,
  actor: string,
  action: string,
  targetType: string,
  targetId: string,
  meta: unknown,
): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      ulid(ctx.now()),
      actor,
      action,
      targetType,
      targetId,
      JSON.stringify(meta ?? null),
      ctx.now(),
    )
    .run();
}

function requireReason(reason: string | undefined): string {
  const r = reason?.trim() ?? '';
  if (r.length < 5) throw new AppError('VALIDATION', 'a reason is required', { field: 'reason' });
  return r.slice(0, 500);
}

interface AccountRow {
  user_id: string;
  status: S3AccountStatus;
  limit_bytes: number;
  used_bytes: number;
  reserved_bytes: number;
  index_binding: string | null;
  billing_state: S3BillingState;
  replicas: number | null;
  period_start: number | null;
}

const toAccount = (r: AccountRow): S3Account => ({
  userId: r.user_id,
  status: r.status,
  limitBytes: r.limit_bytes,
  usedBytes: r.used_bytes,
  reservedBytes: r.reserved_bytes,
  indexBinding: r.index_binding,
  billingState: r.billing_state,
  replicas: r.replicas ?? 1,
  periodStart: r.period_start,
});

export async function getAccount(ctx: Ctx, userId: string): Promise<S3Account | null> {
  const row = await ctx.env.DB.prepare(
    `SELECT a.user_id, a.status, a.limit_bytes, a.used_bytes, a.reserved_bytes, a.index_binding,
       a.billing_state, s.replicas, s.period_start
     FROM s3_accounts a LEFT JOIN s3_subscriptions s ON s.user_id = a.user_id WHERE a.user_id = ?1`,
  )
    .bind(userId)
    .first<AccountRow>();
  return row ? toAccount(row) : null;
}

// ───────────────────────────── storage ─────────────────────────────

/** Reserves `n` bytes before they are written (SPEC §4's atomic reservation, per S3 account). */
export async function reserveBytes(ctx: Ctx, userId: string, n: number): Promise<void> {
  const r = await ctx.env.DB.prepare(
    `UPDATE s3_accounts SET reserved_bytes = reserved_bytes + ?2, updated_at = ?3
     WHERE user_id = ?1 AND status = 'active' AND used_bytes + reserved_bytes + ?2 <= limit_bytes`,
  )
    .bind(userId, n, ctx.now())
    .run();
  if (r.meta.changes === 0) {
    throw new S3Error('QuotaExceeded', 'The storage for this Zeiko S3 account is full.');
  }
}

/** Gives back reserved bytes that were never written. */
export async function releaseBytes(ctx: Ctx, userId: string, n: number): Promise<void> {
  if (n <= 0) return;
  await ctx.env.DB.prepare(
    `UPDATE s3_accounts SET reserved_bytes = MAX(0, reserved_bytes - ?2), updated_at = ?3 WHERE user_id = ?1`,
  )
    .bind(userId, n, ctx.now())
    .run();
}

/** A write finished: `reserved` leaves the reservation and `delta` (new minus replaced) is used. */
export async function commitBytes(
  ctx: Ctx,
  userId: string,
  reserved: number,
  delta: number,
): Promise<void> {
  if (reserved === 0 && delta === 0) return;
  await ctx.env.DB.prepare(
    `UPDATE s3_accounts SET reserved_bytes = MAX(0, reserved_bytes - ?2), used_bytes = MAX(0, used_bytes + ?3),
       updated_at = ?4 WHERE user_id = ?1`,
  )
    .bind(userId, reserved, delta, ctx.now())
    .run();
}

// ───────────────────────────── access keys ─────────────────────────────

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newAccessKeyId(): string {
  let s = 'ZK';
  for (const b of crypto.getRandomValues(new Uint8Array(18))) s += KEY_ALPHABET[b & 31];
  return s;
}

function sealKey(env: Env): string {
  if (!env.S3_KEYS_ENC_KEY) throw new AppError('INTERNAL', 'Zeiko S3 is not configured');
  return env.S3_KEYS_ENC_KEY;
}

/** What a key may touch (ADR-071). The defaults (all null, 'rw') are a full-access key. */
export type KeyAccess = 'rw' | 'r' | 'w';

export interface KeyScope {
  /** Bucket names it may use; null = every bucket of the account. */
  buckets: string[] | null;
  /** Object keys it may use start with this; null = every key. */
  prefix: string | null;
  access: KeyAccess;
  /** ms UTC; null = never. */
  expiresAt: number | null;
}

export const FULL_SCOPE: KeyScope = { buckets: null, prefix: null, access: 'rw', expiresAt: null };

/** A key limited by bucket, prefix or access: it may not create, delete or configure buckets. */
export function isRestricted(scope: KeyScope): boolean {
  return scope.buckets !== null || scope.prefix !== null || scope.access !== 'rw';
}

interface ScopeColumns {
  buckets_json: string | null;
  prefix: string | null;
  access: string | null;
  expires_at: number | null;
}

function scopeOf(row: ScopeColumns): KeyScope {
  let buckets: string[] | null = null;
  if (row.buckets_json !== null) {
    const v: unknown = JSON.parse(row.buckets_json);
    buckets = Array.isArray(v) ? v.filter((b): b is string => typeof b === 'string') : [];
  }
  const access = row.access === 'r' || row.access === 'w' ? row.access : 'rw';
  return { buckets, prefix: row.prefix || null, access, expiresAt: row.expires_at };
}

export interface KeyLookup {
  userId: string;
  secret: string;
  revoked: boolean;
  accountStatus: S3AccountStatus;
  userStatus: string;
  indexBinding: string | null;
  lastUsedAt: number | null;
  scope: KeyScope;
}

const KEY_CACHE_MS = 15_000;
const keyCache = new Map<string, { at: number; value: KeyLookup | null }>();

/**
 * The secret and account behind an access key id. Cached for 15 s per isolate, so revoking a key
 * or suspending an account reaches every request within that.
 */
export async function lookupKey(ctx: Ctx, accessKeyId: string): Promise<KeyLookup | null> {
  if (!/^ZK[A-Z0-9]{18}$/.test(accessKeyId)) return null;
  const hit = keyCache.get(accessKeyId);
  if (hit && Date.now() - hit.at < KEY_CACHE_MS) return hit.value;
  const row = await ctx.env.DB.prepare(
    `SELECT k.user_id, k.secret_enc, k.revoked_at, k.last_used_at, k.buckets_json, k.prefix, k.access,
            k.expires_at, a.status AS account_status, a.index_binding, u.status AS user_status
     FROM s3_keys k JOIN s3_accounts a ON a.user_id = k.user_id JOIN users u ON u.id = k.user_id
     WHERE k.id = ?1`,
  )
    .bind(accessKeyId)
    .first<
      ScopeColumns & {
        user_id: string;
        secret_enc: string;
        revoked_at: number | null;
        last_used_at: number | null;
        account_status: S3AccountStatus;
        index_binding: string | null;
        user_status: string;
      }
    >();
  const value: KeyLookup | null = row
    ? {
        userId: row.user_id,
        secret: await aesGcmDecrypt(sealKey(ctx.env), row.secret_enc),
        revoked: row.revoked_at !== null,
        accountStatus: row.account_status,
        userStatus: row.user_status,
        indexBinding: row.index_binding,
        lastUsedAt: row.last_used_at,
        scope: scopeOf(row),
      }
    : null;
  if (keyCache.size > 2000) keyCache.clear();
  keyCache.set(accessKeyId, { at: Date.now(), value });
  return value;
}

export function forgetKey(accessKeyId: string): void {
  keyCache.delete(accessKeyId);
}

/** "Last used" is written at most once an hour per key (D1 writes are the scarce thing on Free). */
export async function touchKey(ctx: Ctx, accessKeyId: string, key: KeyLookup): Promise<void> {
  const now = ctx.now();
  if (key.lastUsedAt !== null && now - key.lastUsedAt < 3_600_000) return;
  key.lastUsedAt = now;
  await ctx.env.DB.prepare(
    `UPDATE s3_keys SET last_used_at = ?2 WHERE id = ?1 AND (last_used_at IS NULL OR last_used_at < ?3)`,
  )
    .bind(accessKeyId, now, now - 3_600_000)
    .run();
}

export interface KeyDto extends KeyScope {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export async function listKeys(ctx: Ctx, userId: string): Promise<KeyDto[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, label, created_at, last_used_at, buckets_json, prefix, access, expires_at FROM s3_keys
     WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at`,
  )
    .bind(userId)
    .all<
      ScopeColumns & { id: string; label: string; created_at: number; last_used_at: number | null }
    >();
  return results.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    ...scopeOf(r),
  }));
}

export interface KeyScopeInput {
  buckets?: string[] | null | undefined;
  prefix?: string | null | undefined;
  access?: KeyAccess | undefined;
  expiresAt?: number | null | undefined;
}

/** A scope asked for when making a key: its buckets must be the account's own, its date in the future. */
async function checkScope(ctx: Ctx, userId: string, input: KeyScopeInput): Promise<KeyScope> {
  let buckets: string[] | null = null;
  if (input.buckets) {
    buckets = [...new Set(input.buckets)].sort();
    if (buckets.length === 0)
      throw new AppError('VALIDATION', 'pick at least one bucket', { field: 'buckets' });
    for (const b of buckets)
      if ((await getBucket(ctx, b))?.user_id !== userId)
        throw new AppError('NOT_FOUND', 'no such bucket', { field: 'buckets', bucket: b });
  }
  let prefix: string | null = null;
  if (input.prefix) {
    prefix = input.prefix;
    const control = [...prefix].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\u007f');
    if (prefix.startsWith('/') || new TextEncoder().encode(prefix).length > 512 || control)
      throw new AppError('VALIDATION', 'bad prefix', { field: 'prefix' });
  }
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && expiresAt <= ctx.now())
    throw new AppError('VALIDATION', 'the expiry date has passed', { field: 'expiresAt' });
  return { buckets, prefix, access: input.access ?? 'rw', expiresAt };
}

function requireActive(account: S3Account | null): S3Account {
  if (!account || account.status === 'deleting')
    throw new AppError('FORBIDDEN', 'Zeiko S3 is not enabled for this account', {
      reason: 's3_disabled',
    });
  if (account.status !== 'active')
    throw new AppError('ACCOUNT_SUSPENDED', 'this Zeiko S3 account is suspended');
  return account;
}

/** A new key pair. The secret is shown this once; Zeiko keeps it sealed to check signatures. */
export async function createKey(
  ctx: Ctx,
  userId: string,
  label: string,
  scopeInput: KeyScopeInput = {},
): Promise<KeyDto & { secret: string }> {
  requireActive(await getAccount(ctx, userId));
  const scope = await checkScope(ctx, userId, scopeInput);
  const cfg = await ctx.config();
  const id = newAccessKeyId();
  const secret = randomBase62(40);
  const sealed = await aesGcmEncrypt(sealKey(ctx.env), secret);
  const now = ctx.now();
  const r = await ctx.env.DB.prepare(
    `INSERT INTO s3_keys (id, user_id, label, secret_enc, created_at, buckets_json, prefix, access, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?7, ?8, ?9, ?10
     WHERE (SELECT COUNT(*) FROM s3_keys WHERE user_id = ?2 AND revoked_at IS NULL) < ?6`,
  )
    .bind(
      id,
      userId,
      label.trim().slice(0, 60),
      sealed,
      now,
      cfg.s3_max_keys_per_account,
      scope.buckets ? JSON.stringify(scope.buckets) : null,
      scope.prefix,
      scope.access,
      scope.expiresAt,
    )
    .run();
  if (r.meta.changes === 0)
    throw new AppError('CONFLICT', 'too many access keys', { max: cfg.s3_max_keys_per_account });
  await audit(ctx, userId, 's3.key_created', 's3_key', id, { label, ...scope });
  return {
    id,
    label: label.trim().slice(0, 60),
    createdAt: now,
    lastUsedAt: null,
    ...scope,
    secret,
  };
}

export async function revokeKey(ctx: Ctx, userId: string, keyId: string): Promise<void> {
  const r = await ctx.env.DB.prepare(
    `UPDATE s3_keys SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL`,
  )
    .bind(keyId, userId, ctx.now())
    .run();
  if (r.meta.changes === 0) throw new AppError('NOT_FOUND', 'no such key');
  forgetKey(keyId);
  await audit(ctx, userId, 's3.key_revoked', 's3_key', keyId, null);
}

// ───────────────────────────── buckets ─────────────────────────────

export interface BucketRow {
  name: string;
  user_id: string;
  public: number;
  blocked_at: number | null;
  created_at: number;
  /** CORS rules as JSON (ADR-055); null = none. */
  cors_json?: string | null;
  /** Server access logging as JSON (ADR-060); null = off. */
  logging_json?: string | null;
}

/** Amazon's bucket naming rules (path-style addressing, so dots are allowed). */
export function validBucketName(name: string): boolean {
  return (
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) &&
    !name.includes('..') &&
    !/^\d{1,3}(\.\d{1,3}){3}$/.test(name) &&
    !/^(xn--|sthree-)/.test(name) &&
    !/(-s3alias|--ol-s3)$/.test(name)
  );
}

export async function getBucket(ctx: Ctx, name: string): Promise<BucketRow | null> {
  return ctx.env.DB.prepare(
    `SELECT name, user_id, public, blocked_at, created_at, cors_json, logging_json FROM s3_buckets WHERE name = ?1`,
  )
    .bind(name)
    .first<BucketRow>();
}

/** The bucket, if it is this user's: NoSuchBucket when nobody has it, AccessDenied otherwise. */
export async function ownBucket(ctx: Ctx, userId: string, name: string): Promise<BucketRow> {
  const b = await getBucket(ctx, name);
  if (!b)
    throw new S3Error('NoSuchBucket', 'The specified bucket does not exist.', { BucketName: name });
  if (b.user_id !== userId) throw new S3Error('AccessDenied', 'Access Denied');
  return b;
}

export async function listBuckets(ctx: Ctx, userId: string): Promise<BucketRow[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT name, user_id, public, blocked_at, created_at, cors_json, logging_json FROM s3_buckets WHERE user_id = ?1 ORDER BY name`,
  )
    .bind(userId)
    .all<BucketRow>();
  return results;
}

export async function createBucket(
  ctx: Ctx,
  userId: string,
  name: string,
  isPublic: boolean,
): Promise<BucketRow> {
  if (!validBucketName(name))
    throw new S3Error('InvalidBucketName', 'The specified bucket is not valid.', {
      BucketName: name,
    });
  const cfg = await ctx.config();
  const now = ctx.now();
  const r = await ctx.env.DB.prepare(
    `INSERT INTO s3_buckets (name, user_id, public, created_at)
     SELECT ?1, ?2, ?3, ?4
     WHERE (SELECT COUNT(*) FROM s3_buckets WHERE user_id = ?2) < ?5
     ON CONFLICT (name) DO NOTHING`,
  )
    .bind(name, userId, isPublic ? 1 : 0, now, cfg.s3_max_buckets_per_account)
    .run();
  if (r.meta.changes === 0) {
    const existing = await getBucket(ctx, name);
    if (existing?.user_id === userId)
      throw new S3Error('BucketAlreadyOwnedByYou', 'You already own this bucket.', {
        BucketName: name,
      });
    if (existing)
      throw new S3Error('BucketAlreadyExists', 'The requested bucket name is not available.', {
        BucketName: name,
      });
    throw new S3Error('TooManyBuckets', 'You have attempted to create more buckets than allowed.');
  }
  await audit(ctx, userId, 's3.bucket_created', 's3_bucket', name, { public: isPublic });
  return { name, user_id: userId, public: isPublic ? 1 : 0, blocked_at: null, created_at: now };
}

export async function setBucketPublic(
  ctx: Ctx,
  userId: string,
  name: string,
  isPublic: boolean,
): Promise<void> {
  const b = await ownBucket(ctx, userId, name);
  if (isPublic && b.blocked_at !== null)
    throw new S3Error('AccessDenied', 'Zeiko turned off public access for this bucket.');
  if (isPublic && (await getAccount(ctx, userId))?.billingState !== 'ok')
    throw new S3Error('AccountProblem', 'Public buckets wait until the Zeiko S3 bill is paid.');
  await ctx.env.DB.prepare(`UPDATE s3_buckets SET public = ?3 WHERE name = ?1 AND user_id = ?2`)
    .bind(name, userId, isPublic ? 1 : 0)
    .run();
  if (Boolean(b.public) !== isPublic)
    await audit(ctx, userId, 's3.bucket_public', 's3_bucket', name, { public: isPublic });
}

/** Zeiko switches a bucket's public access off (ToS §4.2) or allows it again. */
export async function blockBucket(
  ctx: Ctx,
  actor: string,
  name: string,
  blocked: boolean,
  reason: string | undefined,
): Promise<void> {
  const why = requireReason(reason);
  const r = await ctx.env.DB.prepare(
    blocked
      ? `UPDATE s3_buckets SET blocked_at = ?2, public = 0 WHERE name = ?1`
      : `UPDATE s3_buckets SET blocked_at = NULL WHERE name = ?1`,
  )
    .bind(name, ...(blocked ? [ctx.now()] : []))
    .run();
  if (r.meta.changes === 0) throw new AppError('NOT_FOUND', 'no such bucket');
  await audit(
    ctx,
    actor,
    blocked ? 's3.bucket_blocked' : 's3.bucket_unblocked',
    's3_bucket',
    name,
    {
      reason: why,
    },
  );
}

// ───────────────────────────── accounts (operator) ─────────────────────────────

export interface AccountView extends S3Account {
  email: string;
  name: string;
  zeikoId: string | null;
  buckets: number;
  keys: number;
  createdAt: number;
}

const ACCOUNT_VIEW = `SELECT a.user_id, a.status, a.limit_bytes, a.used_bytes, a.reserved_bytes, a.index_binding,
    a.billing_state, s.replicas, s.period_start, a.created_at, u.email, u.name,
    (SELECT account_id FROM accounts WHERE user_id = a.user_id AND provider_id = 'zeiko' LIMIT 1) AS zeiko_id,
    (SELECT COUNT(*) FROM s3_buckets b WHERE b.user_id = a.user_id) AS buckets,
    (SELECT COUNT(*) FROM s3_keys k WHERE k.user_id = a.user_id AND k.revoked_at IS NULL) AS keys
  FROM s3_accounts a JOIN users u ON u.id = a.user_id LEFT JOIN s3_subscriptions s ON s.user_id = a.user_id`;

type AccountViewRow = AccountRow & {
  created_at: number;
  email: string;
  name: string;
  zeiko_id: string | null;
  buckets: number;
  keys: number;
};

const toView = (r: AccountViewRow): AccountView => ({
  ...toAccount(r),
  email: r.email,
  name: r.name,
  zeikoId: r.zeiko_id,
  buckets: r.buckets,
  keys: r.keys,
  createdAt: r.created_at,
});

export async function listAccounts(ctx: Ctx): Promise<AccountView[]> {
  const { results } = await ctx.env.DB.prepare(
    `${ACCOUNT_VIEW} ORDER BY a.created_at DESC LIMIT 1000`,
  ).all<AccountViewRow>();
  return results.map(toView);
}

export async function accountView(ctx: Ctx, userId: string): Promise<AccountView> {
  const row = await ctx.env.DB.prepare(`${ACCOUNT_VIEW} WHERE a.user_id = ?1`)
    .bind(userId)
    .first<AccountViewRow>();
  if (!row) throw new AppError('NOT_FOUND', 'no Zeiko S3 account for this user');
  return toView(row);
}

/** Drive's user for a Zeiko Account id, an email, or a Drive user id. */
export async function findUser(
  ctx: Ctx,
  who: { userId?: string | undefined; zeikoId?: string | undefined; email?: string | undefined },
): Promise<string> {
  const DB = ctx.env.DB;
  const row = who.userId
    ? await DB.prepare(`SELECT id FROM users WHERE id = ?1 AND status != 'deleted'`)
        .bind(who.userId)
        .first<{ id: string }>()
    : who.zeikoId
      ? await DB.prepare(
          `SELECT u.id FROM accounts a JOIN users u ON u.id = a.user_id
           WHERE a.provider_id = 'zeiko' AND a.account_id = ?1 AND u.status != 'deleted'`,
        )
          .bind(who.zeikoId)
          .first<{ id: string }>()
      : who.email
        ? await DB.prepare(`SELECT id FROM users WHERE email = ?1 AND status != 'deleted'`)
            .bind(who.email.trim().toLowerCase())
            .first<{ id: string }>()
        : null;
  if (!row)
    throw new AppError('NOT_FOUND', 'this person has not signed in to Zeiko Drive yet', {
      reason: 'no_drive_user',
    });
  return row.id;
}

/** Turns Zeiko S3 on for a person with a storage limit (the relay's "add user" button). */
export async function enableAccount(
  ctx: Ctx,
  actor: string,
  userId: string,
  limitBytes: number,
  reason: string | undefined,
): Promise<AccountView> {
  const why = requireReason(reason);
  const now = ctx.now();
  const existing = await getAccount(ctx, userId);
  if (existing?.status === 'deleting')
    throw new AppError('CONFLICT', 'this account is being deleted');
  await ctx.env.DB.prepare(
    `INSERT INTO s3_accounts (user_id, status, limit_bytes, created_by, created_at, updated_at)
     VALUES (?1, 'active', ?2, ?3, ?4, ?4)
     ON CONFLICT (user_id) DO UPDATE SET limit_bytes = excluded.limit_bytes, updated_at = excluded.updated_at`,
  )
    .bind(userId, limitBytes, actor, now)
    .run();
  await audit(ctx, actor, existing ? 's3.account_limit' : 's3.account_enabled', 'user', userId, {
    limitBytes,
    reason: why,
  });
  return accountView(ctx, userId);
}

export async function updateAccount(
  ctx: Ctx,
  actor: string,
  userId: string,
  patch: { limitBytes?: number | undefined; suspended?: boolean | undefined },
  reason: string | undefined,
): Promise<AccountView> {
  const why = requireReason(reason);
  const acc = await getAccount(ctx, userId);
  if (!acc || acc.status === 'deleting')
    throw new AppError('NOT_FOUND', 'no Zeiko S3 account for this user');
  const now = ctx.now();
  if (patch.limitBytes !== undefined) {
    await ctx.env.DB.prepare(
      `UPDATE s3_accounts SET limit_bytes = ?2, updated_at = ?3 WHERE user_id = ?1`,
    )
      .bind(userId, patch.limitBytes, now)
      .run();
  }
  if (patch.suspended !== undefined) {
    await ctx.env.DB.prepare(
      `UPDATE s3_accounts SET status = ?2, updated_at = ?3 WHERE user_id = ?1 AND status != 'deleting'`,
    )
      .bind(userId, patch.suspended ? 'suspended' : 'active', now)
      .run();
  }
  await audit(ctx, actor, 's3.account_updated', 'user', userId, { ...patch, reason: why });
  return accountView(ctx, userId);
}

/**
 * Moves an account's index to a D1 of its own (bound to this Worker as S3_DB_*). Only while the
 * account has nothing in its current index: nothing is copied between databases.
 */
export async function attachIndex(
  ctx: Ctx,
  actor: string,
  userId: string,
  binding: string,
  reason: string | undefined,
): Promise<AccountView> {
  const why = requireReason(reason);
  if (!INDEX_BINDING_RE.test(binding))
    throw new AppError('VALIDATION', 'binding names look like S3_DB_<NAME>', { field: 'binding' });
  const target = boundIndex(ctx.env, binding);
  if (!target)
    throw new AppError(
      'VALIDATION',
      'this Worker has no D1 binding by that name; deploy it first',
      {
        field: 'binding',
      },
    );
  const acc = await getAccount(ctx, userId);
  if (!acc || acc.status === 'deleting')
    throw new AppError('NOT_FOUND', 'no Zeiko S3 account for this user');
  if (acc.indexBinding === binding) return accountView(ctx, userId);
  const taken = await ctx.env.DB.prepare(`SELECT user_id FROM s3_accounts WHERE index_binding = ?1`)
    .bind(binding)
    .first<{ user_id: string }>();
  if (taken) throw new AppError('CONFLICT', 'another account already uses this database');
  const current = await indexDb(ctx.env, acc.indexBinding);
  const busy = await current
    .prepare(
      `SELECT 1 AS x FROM s3_objects WHERE user_id = ?1
       UNION ALL SELECT 1 FROM s3_uploads WHERE user_id = ?1 LIMIT 1`,
    )
    .bind(userId)
    .first<{ x: number }>();
  if (busy)
    throw new AppError(
      'CONFLICT',
      'the account already has objects; its index can only move while empty',
    );
  await ensureIndex(target);
  await ctx.env.DB.prepare(
    `UPDATE s3_accounts SET index_binding = ?2, updated_at = ?3 WHERE user_id = ?1`,
  )
    .bind(userId, binding, ctx.now())
    .run();
  await audit(ctx, actor, 's3.account_index', 'user', userId, {
    from: acc.indexBinding,
    to: binding,
    reason: why,
  });
  return accountView(ctx, userId);
}

// ───────────────────────────── the user's own page ─────────────────────────────

export async function s3Overview(ctx: Ctx, userId: string) {
  const account = await getAccount(ctx, userId);
  const configured = s3Configured(ctx.env);
  const enabled = Boolean(account && account.status !== 'deleting');
  return {
    configured,
    enabled,
    endpoint: ctx.env.S3_ORIGIN ?? null,
    region: S3_REGION,
    account:
      account && enabled
        ? {
            status: account.status,
            limitBytes: account.limitBytes,
            usedBytes: account.usedBytes,
            reservedBytes: account.reservedBytes,
            billingState: account.billingState,
          }
        : null,
    plan: configured ? await s3PlanView(ctx, userId) : null,
    url: enabled ? await s3UrlView(ctx, userId) : null,
    urlOptions: configured ? urlOptions(ctx, await ctx.config()) : null,
    keys: enabled ? await listKeys(ctx, userId) : [],
    buckets: enabled
      ? (await listBuckets(ctx, userId)).map((b) => ({
          name: b.name,
          public: Boolean(b.public),
          blocked: b.blocked_at !== null,
          createdAt: b.created_at,
          /** ADR-055: the rules, for the bucket's CORS editor. */
          cors: b.cors_json ? (JSON.parse(b.cors_json) as unknown) : null,
          /** ADR-060: where its access logs go. */
          logging: b.logging_json ? (JSON.parse(b.logging_json) as unknown) : null,
        }))
      : [],
  };
}
