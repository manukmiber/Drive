// Zeiko S3 addresses of their own (ADR-048): s3.<name>.<S3_SUBDOMAIN_SUFFIX> (s3_url_zeiko_idr) or a
// person's own domain (s3_url_custom_idr), bought once through the checkout while a plan is active.
// One per account. The address answers only for its owner's buckets and keys. It is released (and
// must be bought again) when the plan has gone unpaid for s3_url_release_days, when the person lets
// it go, or when the account is deleted.
import { DAY_MS } from '../../shared/constants';
import { HostnameError } from '../adapters/hostnames';
import type { Ctx } from '../context';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { errorMessage, log } from '../lib/log';
import { invoiceStmts, runMoneyBatch, walletStmts, withTax } from './billing';
import { notify } from './notify';
import { getS3Subscription } from './s3-billing';

export type S3UrlRequest = { type: 'zeiko'; name: string } | { type: 'custom'; hostname: string };

interface UrlRow {
  hostname: string;
  user_id: string;
  kind: 'zeiko' | 'custom';
  /** reserved: being bought right now (never answers, never shown). */
  status: 'reserved' | 'pending' | 'active' | 'failed';
  cf_id: string | null;
  cf_route_id: string | null;
  records_json: string | null;
  error: string | null;
}

/** Names that would pass for Zeiko's own services. */
const RESERVED = new Set(
  (
    'www mail smtp imap pop ftp ns ns1 ns2 mx api app apps admin root auth akun account accounts login ' +
    'signin masuk daftar chat drive staging s3 uc cdn static assets dashboard status support help ' +
    'billing pay bayar zeiko iklan ads relay dev test demo blog docs security abuse privacy legal'
  ).split(' '),
);
const NAME = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The zone Zeiko's own names live in: the CNAME target without its first label. */
function ownZone(env: Env): string | null {
  const t = env.S3_CNAME_TARGET?.toLowerCase();
  return t ? t.slice(t.indexOf('.') + 1) : null;
}

export function urlOptions(
  ctx: Ctx,
  cfg: { s3_url_zeiko_idr: number; s3_url_custom_idr: number; s3_url_release_days: number },
) {
  const ready = ctx.adapters.hostnames !== null;
  return {
    zeiko: {
      available: ready && Boolean(ctx.env.S3_SUBDOMAIN_SUFFIX),
      priceIdr: cfg.s3_url_zeiko_idr,
      suffix: ctx.env.S3_SUBDOMAIN_SUFFIX ?? null,
    },
    custom: {
      available: ready && Boolean(ctx.env.S3_CNAME_TARGET),
      priceIdr: cfg.s3_url_custom_idr,
      cnameTarget: ctx.env.S3_CNAME_TARGET ?? null,
    },
    releaseDays: cfg.s3_url_release_days,
  };
}

/** The address a request asks for, checked, with its kind and price. */
async function resolveRequest(
  ctx: Ctx,
  req: S3UrlRequest,
): Promise<{ hostname: string; kind: 'zeiko' | 'custom'; priceIdr: number }> {
  const cfg = await ctx.config();
  const opts = urlOptions(ctx, cfg);
  if (req.type === 'zeiko') {
    if (!opts.zeiko.available)
      throw new AppError('CONFLICT', 'own addresses are not available here', {
        reason: 'URL_UNAVAILABLE',
      });
    const name = req.name.trim().toLowerCase();
    if (!NAME.test(name) || name.includes('--'))
      throw new AppError('VALIDATION', 'not a usable name', {
        field: 'name',
        reason: 'URL_INVALID',
      });
    if (RESERVED.has(name) || name.includes('zeiko'))
      throw new AppError('VALIDATION', 'that name is Zeiko’s', {
        field: 'name',
        reason: 'URL_RESERVED',
      });
    return {
      hostname: `s3.${name}.${opts.zeiko.suffix!.toLowerCase()}`,
      kind: 'zeiko',
      priceIdr: opts.zeiko.priceIdr,
    };
  }
  if (!opts.custom.available)
    throw new AppError('CONFLICT', 'own addresses are not available here', {
      reason: 'URL_UNAVAILABLE',
    });
  const hostname = req.hostname.trim().toLowerCase().replace(/\.$/, '');
  const labels = hostname.split('.');
  const zone = ownZone(ctx.env);
  const valid =
    hostname.length <= 253 &&
    labels.length >= 3 &&
    labels.every((l) => LABEL.test(l)) &&
    /^[a-z]{2,63}$/.test(labels[labels.length - 1]!) &&
    !(zone && (hostname === zone || hostname.endsWith(`.${zone}`)));
  if (!valid)
    throw new AppError('VALIDATION', 'not a usable domain', {
      field: 'hostname',
      reason: 'URL_INVALID',
    });
  return { hostname, kind: 'custom', priceIdr: opts.custom.priceIdr };
}

/** An active plan, no address yet, and nobody else on this one. */
async function gate(ctx: Ctx, userId: string, hostname: string): Promise<void> {
  const sub = await getS3Subscription(ctx, userId);
  if (!sub || sub.period_end <= ctx.now())
    throw new AppError('CONFLICT', 'an active Zeiko S3 plan is required', { reason: 'NO_PLAN' });
  const DB = ctx.env.DB;
  if (await DB.prepare(`SELECT 1 AS x FROM s3_urls WHERE user_id = ?1`).bind(userId).first())
    throw new AppError('CONFLICT', 'this account already has an address', { reason: 'URL_EXISTS' });
  if (await DB.prepare(`SELECT 1 AS x FROM s3_urls WHERE hostname = ?1`).bind(hostname).first())
    throw new AppError('CONFLICT', 'that address is taken', { reason: 'URL_TAKEN' });
}

export async function quoteS3Url(ctx: Ctx, userId: string, req: S3UrlRequest): Promise<number> {
  const { hostname, priceIdr } = await resolveRequest(ctx, req);
  await gate(ctx, userId, hostname);
  return withTax(ctx, priceIdr);
}

// Who an address belongs to, remembered for a little while per isolate (every request on an
// unknown host asks).
const OWNER_CACHE_MS = 30_000;
const owners = new Map<string, { at: number; owner: string | null }>();

export async function s3UrlOwner(env: Env, hostname: string): Promise<string | null> {
  const now = Date.now();
  const hit = owners.get(hostname);
  if (hit && now - hit.at < OWNER_CACHE_MS) return hit.owner;
  const row = await env.DB.prepare(
    `SELECT user_id FROM s3_urls WHERE hostname = ?1 AND status != 'reserved'`,
  )
    .bind(hostname)
    .first<{ user_id: string }>();
  if (owners.size > 1000) owners.clear();
  owners.set(hostname, { at: now, owner: row?.user_id ?? null });
  return row?.user_id ?? null;
}

/**
 * Holds the name (a `reserved` row, so two buyers can never both get it, and Cloudflare is never
 * asked twice for one name), makes it at Cloudflare, then charges the wallet and keeps it in one
 * batch. Anything failing on the way gives the name back.
 */
export async function buyS3Url(
  ctx: Ctx,
  userId: string,
  req: S3UrlRequest,
): Promise<{ kind: 's3_url'; chargedIdr: number; invoiceId: string }> {
  const { hostname, kind, priceIdr } = await resolveRequest(ctx, req);
  await gate(ctx, userId, hostname);
  const DB = ctx.env.DB;
  const now = ctx.now();
  try {
    await DB.prepare(
      `INSERT INTO s3_urls (hostname, user_id, kind, status, price_idr, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'reserved', 0, ?4, ?4)`,
    )
      .bind(hostname, userId, kind, now)
      .run();
  } catch (e) {
    if (!/UNIQUE|PRIMARY KEY/i.test(String(e))) throw e;
    const mine = await DB.prepare(`SELECT 1 AS x FROM s3_urls WHERE user_id = ?1`)
      .bind(userId)
      .first();
    throw mine
      ? new AppError('CONFLICT', 'this account already has an address', { reason: 'URL_EXISTS' })
      : new AppError('CONFLICT', 'that address is taken', { reason: 'URL_TAKEN' });
  }
  const unreserve = () =>
    DB.prepare(`DELETE FROM s3_urls WHERE hostname = ?1 AND status = 'reserved'`)
      .bind(hostname)
      .run();

  const hn = ctx.adapters.hostnames!;
  let made: Pick<UrlRow, 'status' | 'cf_id' | 'cf_route_id' | 'records_json' | 'error'>;
  try {
    if (kind === 'zeiko') {
      made = {
        status: 'active',
        cf_id: await hn.addZeikoHostname(hostname),
        cf_route_id: null,
        records_json: null,
        error: null,
      };
    } else {
      const h = await hn.addCustomHostname(hostname, ctx.env.S3_CNAME_TARGET ?? '');
      made = {
        status: h.status,
        cf_id: h.id,
        cf_route_id: h.routeId,
        records_json: JSON.stringify(h.records),
        error: h.error,
      };
    }
  } catch (e) {
    await unreserve();
    if (e instanceof HostnameError && e.taken)
      throw new AppError('CONFLICT', 'that address is taken', { reason: 'URL_TAKEN' });
    throw e;
  }
  // Cloudflare's id first, so a reservation left behind by a crash can still be cleaned up there.
  await DB.prepare(`UPDATE s3_urls SET cf_id = ?2, cf_route_id = ?3 WHERE hostname = ?1`)
    .bind(hostname, made.cf_id, made.cf_route_id)
    .run();

  const inv = await invoiceStmts(
    ctx,
    userId,
    [{ label: `Alamat Zeiko S3: ${hostname}`, amountIdr: priceIdr }],
    null,
  );
  try {
    await runMoneyBatch(
      ctx,
      [
        ...walletStmts(ctx, userId, -inv.total, 's3_url', inv.id),
        DB.prepare(
          `UPDATE s3_urls SET status = ?2, records_json = ?3, error = ?4, price_idr = ?5, updated_at = ?6
           WHERE hostname = ?1 AND status = 'reserved'`,
        ).bind(hostname, made.status, made.records_json, made.error, inv.total, ctx.now()),
        ...inv.stmts,
      ],
      inv.total,
    );
  } catch (e) {
    await removeAtCloudflare(ctx, { kind, ...made }).then(unreserve, (x: unknown) =>
      // Kept reserved, so the hourly cleanup tries Cloudflare again.
      log.error('s3_url_orphan', { hostname, message: errorMessage(x) }),
    );
    throw e;
  }
  owners.delete(hostname);
  return { kind: 's3_url', chargedIdr: inv.total, invoiceId: inv.id };
}

async function removeAtCloudflare(
  ctx: Ctx,
  row: Pick<UrlRow, 'kind' | 'cf_id' | 'cf_route_id'>,
): Promise<void> {
  const hn = ctx.adapters.hostnames;
  if (!hn || !row.cf_id) return;
  if (row.kind === 'zeiko') await hn.removeZeikoHostname(row.cf_id);
  else await hn.removeCustomHostname(row.cf_id, row.cf_route_id);
}

async function rowOf(ctx: Ctx, userId: string): Promise<UrlRow | null> {
  return ctx.env.DB.prepare(`SELECT * FROM s3_urls WHERE user_id = ?1`)
    .bind(userId)
    .first<UrlRow>();
}

/** The address as the /s3 page shows it. */
export async function s3UrlView(ctx: Ctx, userId: string) {
  const row = await rowOf(ctx, userId);
  if (!row || row.status === 'reserved') return null;
  const origin = ctx.env.S3_ORIGIN ? new URL(ctx.env.S3_ORIGIN) : null;
  const port = row.kind === 'zeiko' && origin?.port ? `:${origin.port}` : '';
  return {
    hostname: row.hostname,
    kind: row.kind,
    status: row.status,
    url: `${origin?.protocol ?? 'https:'}//${row.hostname}${port}`,
    records: row.records_json ? (JSON.parse(row.records_json) as unknown[]) : [],
    error: row.error,
  };
}

async function refreshRow(ctx: Ctx, row: UrlRow): Promise<void> {
  const hn = ctx.adapters.hostnames;
  if (!hn || row.kind !== 'custom' || !row.cf_id || row.status !== 'pending') return;
  const s = await hn.customHostname(row.cf_id, row.hostname, ctx.env.S3_CNAME_TARGET ?? '');
  await ctx.env.DB.prepare(
    `UPDATE s3_urls SET status = ?2, records_json = ?3, error = ?4, updated_at = ?5 WHERE hostname = ?1`,
  )
    .bind(row.hostname, s.status, JSON.stringify(s.records), s.error, ctx.now())
    .run();
}

/** The person asks again whether their domain's DNS is in place. */
export async function checkS3Url(ctx: Ctx, userId: string) {
  const row = await rowOf(ctx, userId);
  if (!row || row.status === 'reserved') throw new AppError('NOT_FOUND', 'no address');
  await refreshRow(ctx, row);
  return s3UrlView(ctx, userId);
}

/** A purchase that never finished (the request died midway) is let go after this long. */
const RESERVATION_MS = 10 * 60_000;

/** Hourly: domains still waiting for their CNAME, and purchases that never finished. */
export async function refreshPendingUrls(ctx: Ctx): Promise<void> {
  const stale = await ctx.env.DB.prepare(
    `SELECT * FROM s3_urls WHERE status = 'reserved' AND created_at < ?1 LIMIT 50`,
  )
    .bind(ctx.now() - RESERVATION_MS)
    .all<UrlRow>();
  for (const row of stale.results)
    await removeAtCloudflare(ctx, row)
      .then(() =>
        ctx.env.DB.prepare(`DELETE FROM s3_urls WHERE hostname = ?1 AND status = 'reserved'`)
          .bind(row.hostname)
          .run(),
      )
      .catch((e: unknown) =>
        log.warn('s3_url_unreserve_failed', { hostname: row.hostname, message: errorMessage(e) }),
      );
  const { results } = await ctx.env.DB.prepare(
    `SELECT * FROM s3_urls WHERE kind = 'custom' AND status = 'pending' LIMIT 50`,
  ).all<UrlRow>();
  for (const row of results)
    await refreshRow(ctx, row).catch((e: unknown) =>
      log.warn('s3_url_refresh_failed', { hostname: row.hostname, message: errorMessage(e) }),
    );
}

/** Lets an address go: removed at Cloudflare, then forgotten (no refund). */
export async function releaseS3Url(
  ctx: Ctx,
  userId: string,
  why: 'removed' | 'lapsed' | 'deleted',
): Promise<boolean> {
  const row = await rowOf(ctx, userId);
  if (!row || (row.status === 'reserved' && why === 'removed')) return false;
  try {
    await removeAtCloudflare(ctx, row);
  } catch (e) {
    // Kept, so the address never falls through to the app; tried again tonight (lapsed) or by
    // the person.
    log.error('s3_url_release_failed', { hostname: row.hostname, message: errorMessage(e) });
    if (why === 'removed')
      throw new AppError('INTERNAL', 'the address could not be removed right now', {
        reason: 'URL_RELEASE_FAILED',
      });
    return false;
  }
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`DELETE FROM s3_urls WHERE hostname = ?1`).bind(row.hostname),
    ctx.env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, created_at)
       VALUES (?1, ?2, 's3.url_released', 'user', ?3, ?4, ?5)`,
    ).bind(
      ulid(ctx.now()),
      why === 'removed' ? userId : null,
      userId,
      JSON.stringify({ hostname: row.hostname, why }),
      ctx.now(),
    ),
  ]);
  owners.delete(row.hostname);
  if (why === 'lapsed') await notify(ctx, userId, 's3_url_released', { hostname: row.hostname });
  return true;
}

/** Nightly: addresses of plans unpaid for s3_url_release_days (or plans gone) are released. */
export async function releaseLapsedUrls(ctx: Ctx): Promise<number> {
  const cfg = await ctx.config();
  const { results } = await ctx.env.DB.prepare(
    `SELECT u.user_id FROM s3_urls u LEFT JOIN s3_subscriptions s ON s.user_id = u.user_id
     WHERE u.status != 'reserved' AND (s.user_id IS NULL OR s.period_end <= ?1) LIMIT 200`,
  )
    .bind(ctx.now() - cfg.s3_url_release_days * DAY_MS)
    .all<{ user_id: string }>();
  let released = 0;
  for (const r of results) if (await releaseS3Url(ctx, r.user_id, 'lapsed')) released++;
  return released;
}
