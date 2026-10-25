// Zeiko S3 plans (ADR-047), paid upfront: a size in whole GB (at least s3_min_gb) with 1 copy or 3
// (services/s3-replicas.ts), for a billing month, like Drive's plans (ADR-041): QRIS when bought,
// manual renewal with reminders, credit renews by itself. A bigger plan applies now for the rest of
// the period; a smaller one from the next. Egress past the free allowance of a period is added to a
// later renewal. A plan not renewed: read-only, then locked, then (dunning_delete_mode `live`) the
// account's data is deleted. Accounts the operator granted (no plan) are not billed.
import { DAY_MS, GIB, WIB_OFFSET_MS } from '../../shared/constants';
import { formatBytes } from '../../shared/format';
import { addBillingMonth, wibDate } from '../../shared/time';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import {
  invoiceStmts,
  onceKey,
  runMoneyBatch,
  walletBalance,
  walletStmts,
  wibAnchorDay,
  withTax,
  type InvoiceLine,
} from './billing';
import { notify } from './notify';
import { getAccount, s3Configured } from './s3';
import { replicasAvailable } from './s3-replicas';

type Stmt = D1PreparedStatement;
type Config = Awaited<ReturnType<Ctx['config']>>;
export type S3BillingState = 'ok' | 'readonly' | 'locked';
export type Replicas = 1 | 3;

export interface S3SubRow {
  user_id: string;
  gb: number;
  replicas: Replicas;
  next_gb: number | null;
  next_replicas: Replicas | null;
  anchor_day: number;
  period_start: number;
  period_end: number;
}

export async function getS3Subscription(ctx: Ctx, userId: string): Promise<S3SubRow | null> {
  return ctx.env.DB.prepare(
    `SELECT user_id, gb, replicas, next_gb, next_replicas, anchor_day, period_start, period_end
     FROM s3_subscriptions WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<S3SubRow>();
}

const monthly = (cfg: Config, gb: number, replicas: number) =>
  gb * (replicas === 3 ? cfg.s3_price_idr_per_gb_month_3x : cfg.s3_price_idr_per_gb_month);

const planLabel = (gb: number, replicas: number) =>
  `Zeiko S3 ${gb} GB, ${replicas === 3 ? '3 salinan' : '1 salinan'}, sebulan`;

/** 00:00 WIB on the 1st of the month `ms` falls in. */
function wibMonthStart(ms: number): number {
  const d = new Date(ms + WIB_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - WIB_OFFSET_MS;
}

/** The period an account's reads count in: its plan's (billable), or the WIB month without one. */
export function egressPeriod(
  periodStart: number | null,
  now: number,
): { start: number; billable: boolean } {
  return periodStart !== null
    ? { start: periodStart, billable: true }
    : { start: wibMonthStart(now), billable: false };
}

/** Bytes an object read sent out, on the bucket owner's period. */
export async function meterS3Egress(
  ctx: Ctx,
  userId: string,
  periodStart: number | null,
  bytes: number,
): Promise<void> {
  if (bytes <= 0) return;
  const now = ctx.now();
  const p = egressPeriod(periodStart, now);
  await ctx.env.DB.prepare(
    `INSERT INTO s3_usage (user_id, period_start, billable, egress_bytes, billed_blocks, updated_at)
     VALUES (?1, ?2, ?3, ?4, 0, ?5)
     ON CONFLICT (user_id, period_start) DO UPDATE SET egress_bytes = egress_bytes + excluded.egress_bytes,
       updated_at = excluded.updated_at`,
  )
    .bind(userId, p.start, p.billable ? 1 : 0, bytes, now)
    .run();
}

interface OwedEgress {
  periodStart: number;
  egressBytes: number;
  blocks: number;
}

const blocksFor = (cfg: Config, egress: number) =>
  Math.ceil(Math.max(0, egress - cfg.s3_egress_free_bytes) / cfg.s3_egress_block_bytes);

/** Egress blocks of paid periods not charged yet; `before`: only periods that started earlier. */
async function owedEgress(
  ctx: Ctx,
  cfg: Config,
  userId: string,
  before: number | null,
): Promise<OwedEgress[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT period_start, egress_bytes, billed_blocks FROM s3_usage
     WHERE user_id = ?1 AND billable = 1 AND (?2 IS NULL OR period_start < ?2) ORDER BY period_start`,
  )
    .bind(userId, before)
    .all<{ period_start: number; egress_bytes: number; billed_blocks: number }>();
  return results
    .map((r) => ({
      periodStart: r.period_start,
      egressBytes: r.egress_bytes,
      blocks: blocksFor(cfg, r.egress_bytes) - r.billed_blocks,
    }))
    .filter((r) => r.blocks > 0);
}

function egressLines(cfg: Config, owed: OwedEgress[]): InvoiceLine[] {
  return owed.map((o) => ({
    label: `Egress periode ${wibDate(o.periodStart)}: ${formatBytes(o.egressBytes)}, ${o.blocks} × ${formatBytes(cfg.s3_egress_block_bytes)} di atas ${formatBytes(cfg.s3_egress_free_bytes)} gratis`,
    amountIdr: o.blocks * cfg.s3_egress_block_idr,
  }));
}

/**
 * The plan line always; as many egress blocks as the wallet covers (the rest waits for the next
 * renewal), so egress served between the quote and the payment never fails the purchase.
 */
async function fitToWallet(
  ctx: Ctx,
  cfg: Config,
  userId: string,
  planLines: InvoiceLine[],
  owed: OwedEgress[],
): Promise<{ lines: InvoiceLine[]; billed: OwedEgress[] }> {
  const wallet = await walletBalance(ctx, userId);
  const billed = owed.map((o) => ({ ...o }));
  for (;;) {
    const lines = [...planLines, ...egressLines(cfg, billed)];
    const total = await withTax(
      ctx,
      lines.reduce((s, l) => s + l.amountIdr, 0),
    );
    const last = billed[billed.length - 1];
    if (total <= wallet || !last) return { lines, billed };
    last.blocks--;
    if (last.blocks === 0) billed.pop();
  }
}

/** The part of a month's price still to run; a period renewed early has not started yet (all of it). */
function proRata(price: number, sub: S3SubRow, now: number): number {
  const total = sub.period_end - sub.period_start;
  const left = Math.min(total, Math.max(0, sub.period_end - now));
  return total > 0 ? Math.ceil((price * left) / total) : price;
}

async function gate(ctx: Ctx, userId: string): Promise<void> {
  if (!s3Configured(ctx.env))
    throw new AppError('CONFLICT', 'Zeiko S3 is not available here', { reason: 'S3_UNAVAILABLE' });
  const acc = await getAccount(ctx, userId);
  if (acc?.status === 'suspended')
    throw new AppError('FORBIDDEN', 'this Zeiko S3 account is suspended', {
      reason: 'ACCOUNT_SUSPENDED',
    });
  if (acc?.status === 'deleting')
    throw new AppError('CONFLICT', 'this Zeiko S3 account is being deleted');
}

function validPlan(cfg: Config, ctx: Ctx, gb: number, replicas: number): void {
  if (!Number.isInteger(gb) || gb < cfg.s3_min_gb || gb > cfg.s3_max_gb)
    throw new AppError('VALIDATION', 'size out of range', {
      field: 'gb',
      min: cfg.s3_min_gb,
      max: cfg.s3_max_gb,
    });
  if (replicas !== 1 && replicas !== 3)
    throw new AppError('VALIDATION', 'replicas is 1 or 3', { field: 'replicas' });
  if (replicas === 3 && !replicasAvailable(ctx.env))
    throw new AppError('CONFLICT', 'three copies are not available here', {
      reason: 'NO_REPLICAS',
    });
}

type PlanAction = 'new' | 'reactivate' | 'upgrade' | 'schedule' | 'cancel_scheduled';

/** What choosing `gb` × `replicas` does now, and its lines before tax. */
async function planChange(
  ctx: Ctx,
  userId: string,
  gb: number,
  replicas: Replicas,
): Promise<{
  action: PlanAction;
  sub: S3SubRow | null;
  planLines: InvoiceLine[];
  owed: OwedEgress[];
}> {
  const cfg = await ctx.config();
  validPlan(cfg, ctx, gb, replicas);
  await gate(ctx, userId);
  const sub = await getS3Subscription(ctx, userId);
  const now = ctx.now();
  const price = monthly(cfg, gb, replicas);
  const line = { label: planLabel(gb, replicas), amountIdr: price };
  const active = sub !== null && sub.period_end > now;
  if (active && gb === sub.gb && replicas === sub.replicas) {
    if (sub.next_gb !== null) return { action: 'cancel_scheduled', sub, planLines: [], owed: [] };
    throw new AppError('CONFLICT', 'already on this plan', { reason: 'SAME_PLAN' });
  }
  // Never a size below what is stored (an account the operator granted may already hold more).
  const acc = await getAccount(ctx, userId);
  const stored = (acc?.usedBytes ?? 0) + (acc?.reservedBytes ?? 0);
  if (gb * GIB < stored)
    throw new AppError('CONFLICT', 'more is stored than that', {
      reason: 'S3_TOO_SMALL',
      usedBytes: stored,
    });
  if (!sub) return { action: 'new', sub, planLines: [line], owed: [] };
  if (!active)
    return {
      action: 'reactivate',
      sub,
      planLines: [line],
      owed: await owedEgress(ctx, cfg, userId, null),
    };
  const current = monthly(cfg, sub.gb, sub.replicas);
  if (price < current) return { action: 'schedule', sub, planLines: [], owed: [] };
  return {
    action: 'upgrade',
    sub,
    planLines: [
      {
        label: `${planLabel(gb, replicas)}: sisa periode ini`,
        amountIdr: proRata(price - current, sub, now),
      },
    ],
    owed: [],
  };
}

async function quote(ctx: Ctx, planLines: InvoiceLine[], owed: OwedEgress[]): Promise<number> {
  const cfg = await ctx.config();
  const lines = [...planLines, ...egressLines(cfg, owed)];
  return lines.length
    ? withTax(
        ctx,
        lines.reduce((s, l) => s + l.amountIdr, 0),
      )
    : 0;
}

export async function quoteS3Plan(
  ctx: Ctx,
  userId: string,
  gb: number,
  replicas: Replicas,
): Promise<number> {
  const c = await planChange(ctx, userId, gb, replicas);
  return quote(ctx, c.planLines, c.owed);
}

export type S3Done =
  | 's3_subscribed'
  | 's3_reactivated'
  | 's3_upgraded'
  | 's3_renewed'
  | 's3_change_scheduled'
  | 's3_change_cancelled';

/** Copies to make or drop once a plan's number of copies changed. */
async function afterReplicas(ctx: Ctx, userId: string, from: number, to: number): Promise<void> {
  if (from === to) return;
  await ctx.env.CLEANUP_QUEUE.send({
    type: to === 3 ? 's3_replicate' : 's3_unreplicate',
    userId,
  });
}

/** Statements that charge `lines` and mark the egress in `billed` as charged. */
async function chargeStmts(
  ctx: Ctx,
  userId: string,
  lines: InvoiceLine[],
  billed: OwedEgress[],
): Promise<{ total: number; invoiceId: string; stmts: Stmt[] }> {
  const inv = await invoiceStmts(ctx, userId, lines, null);
  const DB = ctx.env.DB;
  return {
    total: inv.total,
    invoiceId: inv.id,
    stmts: [
      ...walletStmts(ctx, userId, -inv.total, 's3_plan', inv.id),
      ...billed.map((o) =>
        DB.prepare(
          `UPDATE s3_usage SET billed_blocks = billed_blocks + ?3 WHERE user_id = ?1 AND period_start = ?2`,
        ).bind(userId, o.periodStart, o.blocks),
      ),
      ...inv.stmts,
    ],
  };
}

function limitStmt(ctx: Ctx, userId: string, gb: number): Stmt {
  return ctx.env.DB.prepare(
    `UPDATE s3_accounts SET limit_bytes = ?2, billing_state = 'ok', updated_at = ?3 WHERE user_id = ?1`,
  ).bind(userId, gb * GIB, ctx.now());
}

/** Buys, changes or brings back a plan, paid from the wallet (the QRIS lands there first). */
export async function buyS3Plan(
  ctx: Ctx,
  userId: string,
  gb: number,
  replicas: Replicas,
): Promise<{ kind: S3Done; chargedIdr: number; invoiceId: string | null }> {
  const cfg = await ctx.config();
  const { action, sub, planLines, owed } = await planChange(ctx, userId, gb, replicas);
  const DB = ctx.env.DB;
  const now = ctx.now();
  if (action === 'schedule' || action === 'cancel_scheduled') {
    const next = action === 'schedule';
    await DB.prepare(
      `UPDATE s3_subscriptions SET next_gb = ?2, next_replicas = ?3, updated_at = ?4 WHERE user_id = ?1`,
    )
      .bind(userId, next ? gb : null, next ? replicas : null, now)
      .run();
    return {
      kind: next ? 's3_change_scheduled' : 's3_change_cancelled',
      chargedIdr: 0,
      invoiceId: null,
    };
  }
  const { lines, billed } = await fitToWallet(ctx, cfg, userId, planLines, owed);
  const charge = await chargeStmts(ctx, userId, lines, billed);
  const anchor = wibAnchorDay(now);
  const fresh = addBillingMonth(now, anchor);
  const stmts: Stmt[] = [...charge.stmts];
  if (action === 'new') {
    stmts.push(
      DB.prepare(
        `INSERT INTO s3_accounts (user_id, status, limit_bytes, created_by, created_at, updated_at)
         VALUES (?1, 'active', ?2, ?1, ?3, ?3)
         ON CONFLICT (user_id) DO UPDATE SET limit_bytes = excluded.limit_bytes, billing_state = 'ok',
           updated_at = excluded.updated_at`,
      ).bind(userId, gb * GIB, now),
      DB.prepare(
        `INSERT INTO s3_subscriptions (user_id, gb, replicas, anchor_day, period_start, period_end, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5, ?5)`,
      ).bind(userId, gb, replicas, anchor, now, fresh),
    );
  } else {
    stmts.push(
      action === 'reactivate'
        ? DB.prepare(
            `UPDATE s3_subscriptions SET gb = ?2, replicas = ?3, next_gb = NULL, next_replicas = NULL,
               anchor_day = ?4, period_start = ?5, period_end = ?6, updated_at = ?5
             WHERE user_id = ?1 AND period_end = ?7`,
          ).bind(userId, gb, replicas, anchor, now, fresh, sub!.period_end)
        : DB.prepare(
            `UPDATE s3_subscriptions SET gb = ?2, replicas = ?3, next_gb = NULL, next_replicas = NULL,
               updated_at = ?4 WHERE user_id = ?1 AND period_end = ?5`,
          ).bind(userId, gb, replicas, now, sub!.period_end),
      limitStmt(ctx, userId, gb),
    );
  }
  await runMoneyBatch(ctx, stmts, charge.total);
  // A first plan on an account the operator had granted may already hold objects.
  await afterReplicas(ctx, userId, sub?.replicas ?? 1, replicas);
  return {
    kind:
      action === 'new'
        ? 's3_subscribed'
        : action === 'reactivate'
          ? 's3_reactivated'
          : 's3_upgraded',
    chargedIdr: charge.total,
    invoiceId: charge.invoiceId,
  };
}

/** The next month of the plan (or the smaller one waiting), plus egress owed from earlier periods. */
async function renewal(ctx: Ctx, userId: string) {
  const cfg = await ctx.config();
  await gate(ctx, userId);
  const sub = await getS3Subscription(ctx, userId);
  if (!sub) throw new AppError('CONFLICT', 'no plan to renew', { reason: 'NO_PLAN' });
  const gb = sub.next_gb ?? sub.gb;
  const replicas = (sub.next_replicas ?? sub.replicas) as Replicas;
  if (replicas === 3 && !replicasAvailable(ctx.env))
    throw new AppError('CONFLICT', 'three copies are not available here', {
      reason: 'NO_REPLICAS',
    });
  const lapsed = sub.period_end <= ctx.now();
  return {
    cfg,
    sub,
    gb,
    replicas,
    lapsed,
    planLines: [{ label: planLabel(gb, replicas), amountIdr: monthly(cfg, gb, replicas) }],
    // A running period's egress is still growing: it waits for the renewal after.
    owed: await owedEgress(ctx, cfg, userId, lapsed ? null : sub.period_start),
  };
}

export async function quoteS3Renew(ctx: Ctx, userId: string): Promise<number> {
  const r = await renewal(ctx, userId);
  return quote(ctx, r.planLines, r.owed);
}

/** Pays the next month: from the end of the period, or from today for a plan that ran out. */
export async function renewS3Plan(
  ctx: Ctx,
  userId: string,
): Promise<{ kind: S3Done; chargedIdr: number; invoiceId: string | null }> {
  const { cfg, sub, gb, replicas, lapsed, planLines, owed } = await renewal(ctx, userId);
  const { lines, billed } = await fitToWallet(ctx, cfg, userId, planLines, owed);
  const charge = await chargeStmts(ctx, userId, lines, billed);
  const now = ctx.now();
  const anchor = lapsed ? wibAnchorDay(now) : sub.anchor_day;
  const start = lapsed ? now : sub.period_end;
  await runMoneyBatch(
    ctx,
    [
      ...charge.stmts,
      ctx.env.DB.prepare(
        `UPDATE s3_subscriptions SET gb = ?2, replicas = ?3, next_gb = NULL, next_replicas = NULL,
           anchor_day = ?4, period_start = ?5, period_end = ?6, updated_at = ?7
         WHERE user_id = ?1 AND period_end = ?8`,
      ).bind(
        userId,
        gb,
        replicas,
        anchor,
        start,
        addBillingMonth(start, anchor),
        now,
        sub.period_end,
      ),
      limitStmt(ctx, userId, gb),
    ],
    charge.total,
  );
  await afterReplicas(ctx, userId, sub.replicas, replicas);
  return {
    kind: lapsed ? 's3_reactivated' : 's3_renewed',
    chargedIdr: charge.total,
    invoiceId: charge.invoiceId,
  };
}

/** Hourly: a plan that just ran out renews itself when credit covers it (as Drive's do). */
export async function renewS3FromCredit(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const { results } = await ctx.env.DB.prepare(
    `SELECT user_id FROM s3_subscriptions WHERE period_end <= ?1 AND period_end > ?2 LIMIT 200`,
  )
    .bind(now, now - DAY_MS)
    .all<{ user_id: string }>();
  let renewed = 0;
  for (const { user_id } of results) {
    const credit = await walletBalance(ctx, user_id);
    if (!credit) continue;
    const price = await quoteS3Renew(ctx, user_id).catch(() => Infinity);
    if (price > credit) continue;
    if (
      await renewS3Plan(ctx, user_id).then(
        () => true,
        () => false,
      )
    )
      renewed++;
  }
  return renewed;
}

/** Nightly: H-3 / H-1 reminders to renew (billing_reminder_days_before), once per period and day. */
export async function remindS3Renewals(ctx: Ctx): Promise<number> {
  const cfg = await ctx.config();
  const now = ctx.now();
  let sent = 0;
  for (const day of cfg.billing_reminder_days_before) {
    const { results } = await ctx.env.DB.prepare(
      `SELECT user_id, period_end FROM s3_subscriptions WHERE period_end > ?1 AND period_end <= ?2`,
    )
      .bind(now + (day - 1) * DAY_MS, now + day * DAY_MS)
      .all<{ user_id: string; period_end: number }>();
    for (const s of results) {
      if (!(await onceKey(ctx, `s3_remind:${s.user_id}:${s.period_end}:${day}`))) continue;
      const amountIdr = await quoteS3Renew(ctx, s.user_id).catch(() => null);
      if (amountIdr === null) continue;
      await notify(ctx, s.user_id, 's3_reminder', {
        days: day,
        periodEnd: s.period_end,
        amountIdr,
        creditCovers: (await walletBalance(ctx, s.user_id)) >= amountIdr,
      });
      sent++;
    }
  }
  return sent;
}

type Dunning = Config['s3_dunning'];

function stateFor(days: number, d: Dunning): S3BillingState {
  if (days >= d.lock_after_days) return 'locked';
  if (days >= d.readonly_after_days) return 'readonly';
  return 'ok';
}

async function audit(ctx: Ctx, action: string, userId: string, meta: unknown) {
  await ctx.env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, created_at)
     VALUES (?1, NULL, ?2, 'user', ?3, ?4, ?5)`,
  )
    .bind(ulid(ctx.now()), action, userId, JSON.stringify(meta), ctx.now())
    .run();
}

export interface S3DunningReport {
  changed: number;
  deleted: number;
  dryRun: string[];
}

/** Nightly: plans not renewed move their accounts to read-only, locked, then deleted (ADR-047). */
export async function runS3Dunning(ctx: Ctx): Promise<S3DunningReport> {
  const cfg = await ctx.config();
  const d = cfg.s3_dunning;
  const now = ctx.now();
  const DB = ctx.env.DB;
  const report: S3DunningReport = { changed: 0, deleted: 0, dryRun: [] };
  // Marked accounts whose plan is gone (deleted by the operator) are let go.
  await DB.prepare(
    `UPDATE s3_accounts SET billing_state = 'ok', updated_at = ?1 WHERE billing_state != 'ok'
       AND user_id NOT IN (SELECT user_id FROM s3_subscriptions)`,
  )
    .bind(now)
    .run();
  const { results } = await DB.prepare(
    `SELECT s.user_id, s.period_end, a.billing_state, a.status FROM s3_subscriptions s
     JOIN s3_accounts a ON a.user_id = s.user_id
     WHERE s.period_end <= ?1 OR a.billing_state != 'ok' LIMIT 500`,
  )
    .bind(now)
    .all<{ user_id: string; period_end: number; billing_state: S3BillingState; status: string }>();
  for (const a of results) {
    if (a.status === 'deleting') continue;
    const days = Math.floor((now - a.period_end) / DAY_MS);
    const state = days < 0 ? 'ok' : stateFor(days, d);
    if (state !== a.billing_state) {
      await DB.prepare(
        `UPDATE s3_accounts SET billing_state = ?2, updated_at = ?3 WHERE user_id = ?1`,
      )
        .bind(a.user_id, state, now)
        .run();
      report.changed++;
    }
    if (days < 0) continue;
    const deleteAt = a.period_end + d.delete_after_days * DAY_MS;
    if (days >= d.delete_after_days) {
      // Never while a payment is on its way.
      const pending = await DB.prepare(
        `SELECT 1 AS p FROM payments WHERE user_id = ?1 AND status = 'pending' LIMIT 1`,
      )
        .bind(a.user_id)
        .first();
      if (pending) continue;
      if (cfg.dunning_delete_mode === 'dry_run') {
        if (await onceKey(ctx, `s3_dunning_dry:${a.user_id}:${wibDate(now)}`))
          await audit(ctx, 's3.dunning.delete.dry_run', a.user_id, { periodEnd: a.period_end });
        report.dryRun.push(a.user_id);
        continue;
      }
      await DB.prepare(
        `UPDATE s3_accounts SET status = 'deleting', updated_at = ?2 WHERE user_id = ?1`,
      )
        .bind(a.user_id, now)
        .run();
      await audit(ctx, 's3.dunning.delete.live', a.user_id, { periodEnd: a.period_end });
      await ctx.env.CLEANUP_QUEUE.send({ type: 's3_purge', userId: a.user_id });
      report.deleted++;
      continue;
    }
    for (const day of d.notify_days_after) {
      if (days < day || days > day + 1) continue;
      if (!(await onceKey(ctx, `s3_dunning:${a.user_id}:${a.period_end}:${day}`))) continue;
      const stage =
        days >= d.delete_after_days - 1
          ? 'delete_warning'
          : days >= d.lock_after_days
            ? 'locked'
            : days >= d.readonly_after_days
              ? 'readonly'
              : 'grace';
      await notify(ctx, a.user_id, 's3_dunning', { stage, days, deleteAt });
    }
  }
  return report;
}

/** Prices, the plan and this period's egress: for the /s3 page and the operator. */
export async function s3PlanView(ctx: Ctx, userId: string) {
  const cfg = await ctx.config();
  const now = ctx.now();
  const [sub, account, credit] = await Promise.all([
    getS3Subscription(ctx, userId),
    getAccount(ctx, userId),
    walletBalance(ctx, userId),
  ]);
  const period = egressPeriod(sub?.period_start ?? null, now);
  const usage = await ctx.env.DB.prepare(
    `SELECT egress_bytes, billed_blocks FROM s3_usage WHERE user_id = ?1 AND period_start = ?2`,
  )
    .bind(userId, period.start)
    .first<{ egress_bytes: number; billed_blocks: number }>();
  const egressBytes = usage?.egress_bytes ?? 0;
  const overBlocks = period.billable
    ? Math.max(0, blocksFor(cfg, egressBytes) - (usage?.billed_blocks ?? 0))
    : 0;
  return {
    prices: {
      perGbMonthIdr: cfg.s3_price_idr_per_gb_month,
      perGbMonth3xIdr: cfg.s3_price_idr_per_gb_month_3x,
      minGb: cfg.s3_min_gb,
      maxGb: cfg.s3_max_gb,
      threeCopies: replicasAvailable(ctx.env),
      egressFreeBytes: cfg.s3_egress_free_bytes,
      egressBlockBytes: cfg.s3_egress_block_bytes,
      egressBlockIdr: cfg.s3_egress_block_idr,
    },
    billingState: account?.billingState ?? 'ok',
    creditIdr: credit,
    plan: sub
      ? {
          gb: sub.gb,
          replicas: sub.replicas,
          periodStart: sub.period_start,
          periodEnd: sub.period_end,
          lapsed: sub.period_end <= now,
          next: sub.next_gb !== null ? { gb: sub.next_gb, replicas: sub.next_replicas } : null,
          renewIdr: await quoteS3Renew(ctx, userId).catch(() => null),
        }
      : null,
    egress: {
      periodStart: period.start,
      bytes: egressBytes,
      billable: period.billable,
      /** This period's egress past the free allowance, charged at the renewal after the next. */
      pendingIdr: overBlocks * cfg.s3_egress_block_idr,
    },
  };
}
