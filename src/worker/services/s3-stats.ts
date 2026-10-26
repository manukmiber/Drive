// Per-bucket statistics and server access logs for Zeiko S3 (ADR-060).
// Counts live in the account's own index database (one row per bucket per WIB day, bumped once per
// request), so a busy account spends its own D1's writes and not the main database's. Access log
// lines wait there too until the hourly cron writes them, as one object per batch, into the target
// bucket the owner chose (always one of their own). Remote IPs are hashed with a salt that changes
// every day: the policy lets Zeiko keep IPs, not hand a visitor's address to a bucket owner.
import { DAY_MS } from '../../shared/constants';
import { wibDate } from '../../shared/time';
import type { Ctx } from '../context';
import { hashIp } from '../lib/crypto';
import { errorMessage, log } from '../lib/log';
import { S3Error } from '../lib/s3-errors';
import { xmlDoc, xmlElements, xmlText } from '../lib/s3-xml';
import { getAccount, getBucket, ownBucket, type BucketRow, type S3Account } from './s3';
import { indexDb } from './s3-index';
import { putObject } from './s3-objects';

const WIB_OFFSET_MS = 7 * 3600_000;
/** Start of the WIB day `ms` falls in, as UTC ms. */
export const wibDay = (ms: number) =>
  Math.floor((ms + WIB_OFFSET_MS) / DAY_MS) * DAY_MS - WIB_OFFSET_MS;

// ───────────────────────────── logging configuration ─────────────────────────────

export interface LoggingConfig {
  target: string;
  prefix: string;
}

export const MAX_LOG_PREFIX = 512;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const UNSAFE_IN_QUOTES = /["\\\u0000-\u001f\u007f]/g;

export function bucketLogging(b: Pick<BucketRow, 'logging_json'>): LoggingConfig | null {
  if (!b.logging_json) return null;
  try {
    const v = JSON.parse(b.logging_json) as Partial<LoggingConfig>;
    return typeof v.target === 'string'
      ? { target: v.target, prefix: typeof v.prefix === 'string' ? v.prefix : '' }
      : null;
  } catch {
    return null;
  }
}

/** BucketLoggingStatus: LoggingEnabled with a target, or empty (off). Grants are not supported. */
export function parseLoggingXml(xml: string): LoggingConfig | null {
  if (!xmlElements(xml, 'BucketLoggingStatus').length)
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema.',
    );
  const enabled = xmlElements(xml, 'LoggingEnabled')[0];
  if (enabled === undefined) return null;
  if (xmlElements(enabled, 'TargetGrants').some((g) => xmlElements(g, 'Grant').length))
    throw new S3Error(
      'NotImplemented',
      'Log target grants are not supported: logs belong to the bucket owner.',
    );
  if (
    xmlElements(enabled, 'TargetObjectKeyFormat').some(
      (f) => xmlElements(f, 'PartitionedPrefix').length,
    )
  )
    throw new S3Error('NotImplemented', 'Partitioned log keys are not supported by Zeiko S3.');
  const target = xmlText(enabled, 'TargetBucket');
  if (!target)
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema.',
    );
  return { target, prefix: xmlText(enabled, 'TargetPrefix') ?? '' };
}

export function loggingXml(cfg: LoggingConfig | null): string {
  return xmlDoc(
    'BucketLoggingStatus',
    cfg ? { LoggingEnabled: { TargetBucket: cfg.target, TargetPrefix: cfg.prefix } } : {},
  );
}

/** Owner only, and the target must be the owner's bucket too. `null` turns logging off. */
export async function setBucketLogging(
  ctx: Ctx,
  userId: string,
  name: string,
  cfg: LoggingConfig | null,
): Promise<LoggingConfig | null> {
  const bucket = await ownBucket(ctx, userId, name);
  if (cfg) {
    const target = await getBucket(ctx, cfg.target);
    if (!target || target.user_id !== userId)
      throw new S3Error(
        'InvalidTargetBucketForLogging',
        'The target bucket for logging does not exist or is not yours.',
        { TargetBucket: cfg.target },
      );
    if (cfg.prefix.length > MAX_LOG_PREFIX || CONTROL.test(cfg.prefix))
      throw new S3Error('InvalidArgument', 'The target prefix is not valid.');
  }
  await ctx.env.DB.prepare(
    `UPDATE s3_buckets SET logging_json = ?3, logs_at = COALESCE(logs_at, ?4) WHERE name = ?1 AND user_id = ?2`,
  )
    .bind(name, userId, cfg ? JSON.stringify(cfg) : null, ctx.now())
    .run();
  // Turning it off: lines still waiting are not delivered any more.
  if (!cfg && bucket.logging_json) {
    const account = await getAccount(ctx, userId);
    if (account) await dropBucketStats(ctx, account, name, { daysToo: false });
  }
  return cfg;
}

export async function getBucketLogging(ctx: Ctx, userId: string, name: string) {
  return bucketLogging(await ownBucket(ctx, userId, name));
}

// ───────────────────────────── recording ─────────────────────────────

export interface S3RequestRecord {
  bucket: BucketRow;
  /** The bucket owner's account, when the request already loaded it. */
  account: S3Account | null;
  /** When the request arrived, and how long it took (ms). */
  at: number;
  ms: number;
  method: string;
  url: URL;
  key: string | null;
  status: number;
  errorCode: string | null;
  bytesIn: number;
  bytesOut: number;
  objectSize: number | null;
  ip: string;
  /** The signing account, or null for an anonymous request. */
  requester: string | null;
  requestId: string;
  referer: string | null;
  userAgent: string | null;
  host: string;
  auth: 'AuthHeader' | 'QueryString' | null;
}

/** Amazon's operation names in access logs (REST.GET.OBJECT and so on). */
export function restOperation(method: string, key: string | null, query: URLSearchParams): string {
  const has = (k: string) => query.has(k);
  if (method === 'OPTIONS') return 'REST.OPTIONS.PREFLIGHT';
  if (key !== null) {
    if (has('uploadId'))
      return method === 'PUT'
        ? 'REST.PUT.PART'
        : method === 'POST'
          ? 'REST.POST.UPLOAD'
          : `REST.${method}.UPLOAD`;
    if (has('uploads')) return 'REST.POST.UPLOADS';
    if (has('acl')) return `REST.${method}.ACL`;
    return `REST.${method}.OBJECT`;
  }
  const sub: Array<[string, string]> = [
    ['cors', 'CORS'],
    ['logging', 'LOGGING_STATUS'],
    ['acl', 'ACL'],
    ['location', 'LOCATION'],
    ['versioning', 'VERSIONING'],
    ['uploads', 'UPLOADS'],
    ['delete', 'MULTI_OBJECT_DELETE'],
  ];
  for (const [q, name] of sub) if (has(q)) return `REST.${method}.${name}`;
  return `REST.${method}.BUCKET`;
}

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** [06/Feb/2019:00:00:38 +0000] */
export function logTime(ms: number): string {
  const d = new Date(ms);
  return `[${pad(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000]`;
}

const field = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? '-' : String(v);
/** A quoted field: no quotes or control characters inside, bounded. */
const quote = (v: string | null) =>
  v ? `"${v.replace(UNSAFE_IN_QUOTES, '_').slice(0, 1024)}"` : '"-"';

/** The request line, with a presigned URL's signature left out. */
function requestUri(method: string, url: URL): string {
  const q = new URLSearchParams(url.search);
  if (q.has('X-Amz-Signature')) q.set('X-Amz-Signature', 'REDACTED');
  const query = q.toString();
  return `${method} ${url.pathname}${query ? `?${query}` : ''} HTTP/1.1`;
}

/** One line in Amazon's server access log format. */
export async function logLine(ctx: Ctx, rec: S3RequestRecord): Promise<string> {
  const owner = rec.bucket.user_id;
  const ip = await hashIp(ctx.env.IP_HASH_SECRET, rec.ip, `s3log|${owner}|${wibDate(rec.at)}`);
  return [
    owner,
    rec.bucket.name,
    logTime(rec.at),
    ip,
    field(rec.requester),
    rec.requestId,
    restOperation(rec.method, rec.key, new URLSearchParams(rec.url.search)),
    rec.key === null ? '-' : encodeURIComponent(rec.key).replace(/%2F/g, '/'),
    quote(requestUri(rec.method, rec.url)),
    rec.status,
    field(rec.errorCode),
    field(rec.bytesOut || null),
    field(rec.objectSize),
    rec.ms,
    '-',
    quote(rec.referer),
    quote(rec.userAgent),
    '-', // version id
    '-', // host id
    rec.auth ? 'SigV4' : '-',
    '-', // cipher suite
    field(rec.auth),
    rec.host,
    '-', // TLS version
    '-', // access point ARN
    '-', // ACL required
  ].join(' ');
}

/** Counts the request for its bucket and, if the bucket logs, queues its log line. */
export async function recordS3Request(ctx: Ctx, rec: S3RequestRecord): Promise<void> {
  const owner = rec.bucket.user_id;
  const account = rec.account?.userId === owner ? rec.account : await getAccount(ctx, owner);
  if (!account) return;
  const db = await indexDb(ctx.env, account.indexBinding);
  const stmts = [
    db
      .prepare(
        `INSERT INTO s3_bucket_days (user_id, bucket, day, requests, errors, ingress_bytes, egress_bytes)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6)
         ON CONFLICT (user_id, bucket, day) DO UPDATE SET requests = requests + 1,
           errors = errors + excluded.errors, ingress_bytes = ingress_bytes + excluded.ingress_bytes,
           egress_bytes = egress_bytes + excluded.egress_bytes`,
      )
      .bind(
        owner,
        rec.bucket.name,
        wibDay(rec.at),
        rec.status >= 400 ? 1 : 0,
        rec.bytesIn,
        rec.status < 300 ? rec.bytesOut : 0,
      ),
  ];
  if (bucketLogging(rec.bucket))
    stmts.push(
      db
        .prepare(`INSERT INTO s3_log_lines (user_id, bucket, at, line) VALUES (?1, ?2, ?3, ?4)`)
        .bind(owner, rec.bucket.name, rec.at, await logLine(ctx, rec)),
    );
  await db.batch(stmts);
}

/** A bucket's counters and waiting log lines go with it (DeleteBucket, logging turned off). */
export async function dropBucketStats(
  ctx: Ctx,
  account: S3Account,
  bucket: string,
  opts: { daysToo: boolean } = { daysToo: true },
): Promise<void> {
  const db = await indexDb(ctx.env, account.indexBinding);
  const stmts = [
    db
      .prepare(`DELETE FROM s3_log_lines WHERE user_id = ?1 AND bucket = ?2`)
      .bind(account.userId, bucket),
  ];
  if (opts.daysToo)
    stmts.push(
      db
        .prepare(`DELETE FROM s3_bucket_days WHERE user_id = ?1 AND bucket = ?2`)
        .bind(account.userId, bucket),
    );
  await db.batch(stmts);
}

// ───────────────────────────── reading ─────────────────────────────

export interface BucketDay {
  day: number;
  requests: number;
  errors: number;
  ingressBytes: number;
  egressBytes: number;
}

export interface BucketStats {
  objects: number;
  bytes: number;
  days: BucketDay[];
  logging: LoggingConfig | null;
}

/** Owner only: object count and bytes from the index, and the last `days` WIB days (oldest first). */
export async function bucketStats(
  ctx: Ctx,
  account: S3Account,
  name: string,
  days = 30,
): Promise<BucketStats> {
  const bucket = await ownBucket(ctx, account.userId, name);
  const db = await indexDb(ctx.env, account.indexBinding);
  const today = wibDay(ctx.now());
  const from = today - (days - 1) * DAY_MS;
  const [size, rows] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM s3_objects WHERE user_id = ?1 AND bucket = ?2`,
      )
      .bind(account.userId, name),
    db
      .prepare(
        `SELECT day, requests, errors, ingress_bytes, egress_bytes FROM s3_bucket_days
         WHERE user_id = ?1 AND bucket = ?2 AND day >= ?3 ORDER BY day`,
      )
      .bind(account.userId, name, from),
  ]);
  const total = (size?.results[0] ?? { n: 0, b: 0 }) as { n: number; b: number };
  const byDay = new Map(
    (
      (rows?.results ?? []) as Array<{
        day: number;
        requests: number;
        errors: number;
        ingress_bytes: number;
        egress_bytes: number;
      }>
    ).map((r) => [r.day, r]),
  );
  const out: BucketDay[] = [];
  for (let d = from; d <= today; d += DAY_MS) {
    const r = byDay.get(d);
    out.push({
      day: d,
      requests: r?.requests ?? 0,
      errors: r?.errors ?? 0,
      ingressBytes: r?.ingress_bytes ?? 0,
      egressBytes: r?.egress_bytes ?? 0,
    });
  }
  return { objects: total.n, bytes: total.b, days: out, logging: bucketLogging(bucket) };
}

/** Every counter row of the account, for its data export. */
export async function exportBucketDays(ctx: Ctx, userId: string): Promise<unknown[]> {
  const account = await getAccount(ctx, userId);
  if (!account) return [];
  const db = await indexDb(ctx.env, account.indexBinding);
  const { results } = await db
    .prepare(
      `SELECT bucket, day, requests, errors, ingress_bytes, egress_bytes FROM s3_bucket_days
       WHERE user_id = ?1 ORDER BY bucket, day`,
    )
    .bind(userId)
    .all();
  return results;
}

// ───────────────────────────── delivery (cron) ─────────────────────────────

/** 2026-10-26-08-15-02-1A2B3C4D5E6F7A8B, Amazon's log object name after the prefix. */
export function logObjectName(ms: number): string {
  const d = new Date(ms);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, '0'),
  )
    .join('')
    .toUpperCase();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}-${rand}`;
}

/**
 * Hourly: waiting log lines become objects in each bucket's target, the buckets least recently
 * delivered first. A target that is gone or not the owner's any more turns logging off; an account
 * that cannot write (unpaid, full) keeps its lines until `s3_log_pending_days`.
 */
export async function deliverS3Logs(ctx: Ctx): Promise<number> {
  const cfg = await ctx.config();
  const { results } = await ctx.env.DB.prepare(
    `SELECT name, user_id, public, blocked_at, created_at, cors_json, logging_json FROM s3_buckets
     WHERE logging_json IS NOT NULL ORDER BY logs_at LIMIT ?1`,
  )
    .bind(cfg.s3_log_buckets_per_run)
    .all<BucketRow>();
  let delivered = 0;
  for (const bucket of results) {
    try {
      delivered += await deliverBucket(ctx, bucket, cfg.s3_log_lines_per_object);
    } catch (e) {
      log.warn('s3_log_delivery_failed', { bucket: bucket.name, message: errorMessage(e) });
    }
    await ctx.env.DB.prepare(`UPDATE s3_buckets SET logs_at = ?2 WHERE name = ?1`)
      .bind(bucket.name, ctx.now())
      .run();
  }
  return delivered;
}

async function deliverBucket(ctx: Ctx, bucket: BucketRow, perObject: number): Promise<number> {
  const cfg = bucketLogging(bucket);
  const account = await getAccount(ctx, bucket.user_id);
  if (!cfg || !account || account.status === 'deleting') return 0;
  const target = await getBucket(ctx, cfg.target);
  if (!target || target.user_id !== bucket.user_id) {
    await setBucketLogging(ctx, bucket.user_id, bucket.name, null);
    return 0;
  }
  const db = await indexDb(ctx.env, account.indexBinding);
  const { results } = await db
    .prepare(
      `SELECT id, line FROM s3_log_lines WHERE user_id = ?1 AND bucket = ?2 ORDER BY id LIMIT ?3`,
    )
    .bind(bucket.user_id, bucket.name, perObject)
    .all<{ id: number; line: string }>();
  if (!results.length) return 0;
  const lastId = results[results.length - 1]!.id;
  if (account.status === 'active' && account.billingState === 'ok') {
    const bytes = new TextEncoder().encode(`${results.map((r) => r.line).join('\n')}\n`);
    try {
      await putObject(ctx, account, {
        bucket: target.name,
        key: `${cfg.prefix}${logObjectName(ctx.now())}`,
        body: new Blob([bytes]).stream(),
        size: bytes.length,
        contentType: 'text/plain',
        meta: {},
      });
    } catch (e) {
      log.warn('s3_log_put_failed', { bucket: bucket.name, message: errorMessage(e) });
      await dropStale(ctx, db, bucket);
      return 0;
    }
    await db
      .prepare(`DELETE FROM s3_log_lines WHERE user_id = ?1 AND bucket = ?2 AND id <= ?3`)
      .bind(bucket.user_id, bucket.name, lastId)
      .run();
    return 1;
  }
  await dropStale(ctx, db, bucket);
  return 0;
}

async function dropStale(ctx: Ctx, db: D1Database, bucket: BucketRow): Promise<void> {
  const cfg = await ctx.config();
  await db
    .prepare(`DELETE FROM s3_log_lines WHERE user_id = ?1 AND bucket = ?2 AND at < ?3`)
    .bind(bucket.user_id, bucket.name, ctx.now() - cfg.s3_log_pending_days * DAY_MS)
    .run();
}

/** Nightly, per account (with the reconciliation): counters older than `s3_stats_keep_days`. */
export async function pruneBucketStats(ctx: Ctx, db: D1Database, userId: string): Promise<void> {
  const cfg = await ctx.config();
  const now = ctx.now();
  await db.batch([
    db
      .prepare(`DELETE FROM s3_bucket_days WHERE user_id = ?1 AND day < ?2`)
      .bind(userId, wibDay(now) - cfg.s3_stats_keep_days * DAY_MS),
    db
      .prepare(`DELETE FROM s3_log_lines WHERE user_id = ?1 AND at < ?2`)
      .bind(userId, now - cfg.s3_log_pending_days * DAY_MS),
  ]);
}
