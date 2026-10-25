// Zeiko S3 billing (ADR-047), postpaid. Every hour each account's stored bytes are sampled into its
// month's usage (GiB-hours), and every byte served is added as egress. On the 1st (WIB) the month
// before is billed: average GB stored × the price, plus egress past the free allowance per started
// block. A bill under the minimum is carried into the next one. Bills are paid by QRIS like any
// purchase (CheckoutItem `s3_bills`), or at once from credit. Unpaid past the due date: read-only,
// then locked, then (dunning_delete_mode `live`) the account's data is deleted.
import { DAY_MS, GIB, HOUR_MS, WIB_OFFSET_MS } from '../../shared/constants';
import { formatBytes, formatRupiah } from '../../shared/format';
import { wibDate } from '../../shared/time';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { log } from '../lib/log';
import {
  invoiceStmts,
  onceKey,
  runMoneyBatch,
  walletBalance,
  walletStmts,
  withTax,
} from './billing';
import { notify } from './notify';

type Stmt = D1PreparedStatement;
export type S3BillingState = 'ok' | 'readonly' | 'locked';
export type S3BillStatus = 'open' | 'paid' | 'carried' | 'waived';

/** The billing month (WIB) a moment falls in: YYYY-MM. */
export function s3Period(ms: number): string {
  return wibDate(ms).slice(0, 7);
}

/** UTC ms where a billing month starts and ends. */
export function periodBounds(period: string): { start: number; end: number } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return { start: Date.UTC(y, m - 1, 1) - WIB_OFFSET_MS, end: Date.UTC(y, m, 1) - WIB_OFFSET_MS };
}

export function periodHours(period: string): number {
  const { start, end } = periodBounds(period);
  return (end - start) / HOUR_MS;
}

/** Hours a late sample may stand for (the cron missed a run), so nothing is billed twice. */
const SAMPLE_GAP_MAX_HOURS = 3;

/** Hourly: what every account stores now counts for one more hour of its month. */
export async function sampleS3Storage(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const r = await ctx.env.DB.prepare(
    `INSERT INTO s3_usage (user_id, period, gib_hours, egress_bytes, last_hour, updated_at)
     SELECT user_id, ?1, used_bytes / ${GIB}.0, 0, ?2, ?3 FROM s3_accounts
     WHERE used_bytes > 0 AND status != 'deleting'
     ON CONFLICT (user_id, period) DO UPDATE SET
       gib_hours = gib_hours + excluded.gib_hours *
         (CASE WHEN last_hour = 0 THEN 1 ELSE MIN(?4, excluded.last_hour - last_hour) END),
       last_hour = excluded.last_hour, updated_at = excluded.updated_at
     WHERE excluded.last_hour > s3_usage.last_hour`,
  )
    .bind(s3Period(now), Math.floor(now / HOUR_MS), now, SAMPLE_GAP_MAX_HOURS)
    .run();
  return r.meta.changes;
}

/** Bytes an object read sent out, on the bucket owner's month. */
export async function meterS3Egress(ctx: Ctx, userId: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  const now = ctx.now();
  await ctx.env.DB.prepare(
    `INSERT INTO s3_usage (user_id, period, gib_hours, egress_bytes, last_hour, updated_at)
     VALUES (?1, ?2, 0, ?3, 0, ?4)
     ON CONFLICT (user_id, period) DO UPDATE SET egress_bytes = egress_bytes + excluded.egress_bytes,
       updated_at = excluded.updated_at`,
  )
    .bind(userId, s3Period(now), bytes, now)
    .run();
}

export interface S3BillLine {
  kind: 'storage' | 'egress' | 'carried';
  label: string;
  amountIdr: number;
  gibMonths?: number;
  egressBytes?: number;
  blocks?: number;
}

export interface S3Prices {
  perGbMonthIdr: number;
  egressFreeBytes: number;
  egressBlockBytes: number;
  egressBlockIdr: number;
  dueDays: number;
}

async function prices(ctx: Ctx): Promise<S3Prices> {
  const cfg = await ctx.config();
  return {
    perGbMonthIdr: cfg.s3_price_idr_per_gb_month,
    egressFreeBytes: cfg.s3_egress_free_bytes,
    egressBlockBytes: cfg.s3_egress_block_bytes,
    egressBlockIdr: cfg.s3_egress_block_idr,
    dueDays: cfg.s3_bill_due_days,
  };
}

/** What a month's usage costs before tax, line by line. */
export function usageLines(
  period: string,
  gibHours: number,
  egressBytes: number,
  p: S3Prices,
): { gibMonths: number; lines: S3BillLine[] } {
  const gibMonths = gibHours / periodHours(period);
  const over = Math.max(0, egressBytes - p.egressFreeBytes);
  const blocks = Math.ceil(over / p.egressBlockBytes);
  return {
    gibMonths,
    lines: [
      {
        kind: 'storage',
        label: `Penyimpanan ${period}: rata-rata ${gibMonths.toFixed(2)} GB × ${formatRupiah(p.perGbMonthIdr)}`,
        amountIdr: Math.round(gibMonths * p.perGbMonthIdr),
        gibMonths,
      },
      {
        kind: 'egress',
        label:
          `Egress ${period}: ${formatBytes(egressBytes)}, gratis ${formatBytes(p.egressFreeBytes)}` +
          (blocks
            ? `, ${blocks} × ${formatBytes(p.egressBlockBytes)} × ${formatRupiah(p.egressBlockIdr)}`
            : ''),
        amountIdr: blocks * p.egressBlockIdr,
        egressBytes,
        blocks,
      },
    ],
  };
}

const sum = (xs: Array<{ amountIdr: number }>) => xs.reduce((s, x) => s + x.amountIdr, 0);

/**
 * Nightly: bills every finished month that has usage and no bill yet. A bill credit covers is paid
 * at once. Returns how many bills were written.
 */
export async function issueS3Bills(ctx: Ctx, limit = 200): Promise<number> {
  const cfg = await ctx.config();
  const p = await prices(ctx);
  const now = ctx.now();
  const DB = ctx.env.DB;
  const { results } = await DB.prepare(
    `SELECT u.user_id, u.period, u.gib_hours, u.egress_bytes FROM s3_usage u
     WHERE u.period < ?1
       AND NOT EXISTS (SELECT 1 FROM s3_bills b WHERE b.user_id = u.user_id AND b.period = u.period)
     ORDER BY u.period LIMIT ?2`,
  )
    .bind(s3Period(now), limit)
    .all<{ user_id: string; period: string; gib_hours: number; egress_bytes: number }>();
  let issued = 0;
  for (const u of results) {
    const { gibMonths, lines } = usageLines(u.period, u.gib_hours, u.egress_bytes, p);
    const { results: carried } = await DB.prepare(
      `SELECT id, period, subtotal_idr FROM s3_bills
       WHERE user_id = ?1 AND status = 'carried' AND carried_into IS NULL ORDER BY period`,
    )
      .bind(u.user_id)
      .all<{ id: string; period: string; subtotal_idr: number }>();
    if (carried.length) {
      lines.push({
        kind: 'carried',
        label: `Sisa tagihan ${carried.map((c) => c.period).join(', ')}`,
        amountIdr: carried.reduce((s, c) => s + c.subtotal_idr, 0),
      });
    }
    const subtotal = sum(lines);
    const total = await withTax(ctx, subtotal);
    const status: S3BillStatus =
      total === 0 ? 'paid' : total < cfg.s3_bill_min_idr ? 'carried' : 'open';
    const id = ulid(now);
    const dueAt = status === 'open' ? now + p.dueDays * DAY_MS : null;
    const stmts: Stmt[] = [
      DB.prepare(
        `INSERT INTO s3_bills (id, user_id, period, gib_months, egress_bytes, lines_json, subtotal_idr,
           total_idr, status, due_at, paid_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        id,
        u.user_id,
        u.period,
        gibMonths,
        u.egress_bytes,
        JSON.stringify(lines),
        subtotal,
        total,
        status,
        dueAt,
        status === 'paid' ? now : null,
        now,
      ),
    ];
    if (carried.length) {
      stmts.push(
        DB.prepare(
          `UPDATE s3_bills SET carried_into = ?1
           WHERE user_id = ?2 AND status = 'carried' AND carried_into IS NULL AND id != ?1`,
        ).bind(id, u.user_id),
      );
    }
    try {
      await DB.batch(stmts);
    } catch (e) {
      // Another run billed this month first (UNIQUE user_id, period).
      log.warn('s3_bill_skipped', { userId: u.user_id, period: u.period, error: String(e) });
      continue;
    }
    issued++;
    if (status !== 'open') continue;
    let paid = false;
    if ((await walletBalance(ctx, u.user_id)) >= total) {
      paid = await payS3Bills(ctx, u.user_id, [id]).then(
        () => true,
        () => false,
      );
    }
    await notify(ctx, u.user_id, 's3_bill', {
      billId: id,
      period: u.period,
      totalIdr: total,
      dueAt,
      paid,
    });
  }
  return issued;
}

interface OpenBill {
  id: string;
  period: string;
  subtotal_idr: number;
}

async function openBills(ctx: Ctx, userId: string, billIds: string[]): Promise<OpenBill[]> {
  const ids = [...new Set(billIds)].slice(0, 24);
  if (!ids.length) return [];
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, period, subtotal_idr FROM s3_bills WHERE user_id = ?1 AND status = 'open'
       AND id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')}) ORDER BY period`,
  )
    .bind(userId, ...ids)
    .all<OpenBill>();
  return results;
}

/** What paying these bills costs now, tax included: the same sum `payS3Bills` takes. */
export async function quoteS3Bills(ctx: Ctx, userId: string, billIds: string[]): Promise<number> {
  const bills = await openBills(ctx, userId, billIds);
  if (!bills.length) throw new AppError('CONFLICT', 'nothing to pay', { reason: 'NO_BILL' });
  return withTax(
    ctx,
    bills.reduce((s, b) => s + b.subtotal_idr, 0),
  );
}

/** Pays open bills from the wallet (the payment, or credit, is already there). */
export async function payS3Bills(
  ctx: Ctx,
  userId: string,
  billIds: string[],
): Promise<{ chargedIdr: number; invoiceId: string }> {
  const bills = await openBills(ctx, userId, billIds);
  if (!bills.length) throw new AppError('CONFLICT', 'nothing to pay', { reason: 'NO_BILL' });
  const inv = await invoiceStmts(
    ctx,
    userId,
    bills.map((b) => ({ label: `Zeiko S3 ${b.period}`, amountIdr: b.subtotal_idr })),
    null,
  );
  const now = ctx.now();
  const DB = ctx.env.DB;
  await runMoneyBatch(
    ctx,
    [
      ...walletStmts(ctx, userId, -inv.total, 's3_bill', inv.id),
      ...bills.map((b) =>
        DB.prepare(
          `UPDATE s3_bills SET status = 'paid', paid_at = ?2, invoice_id = ?3 WHERE id = ?1 AND status = 'open'`,
        ).bind(b.id, now, inv.id),
      ),
      ...inv.stmts,
    ],
    inv.total,
  );
  await refreshBillingState(ctx, userId);
  return { chargedIdr: inv.total, invoiceId: inv.id };
}

type Dunning = Awaited<ReturnType<Ctx['config']>>['s3_dunning'];

/** Days since the oldest unpaid bill fell due (negative: not due yet), or null: nothing unpaid. */
function daysOverdue(due: number | null, now: number): number | null {
  return due === null ? null : Math.floor((now - due) / DAY_MS);
}

function stateFor(days: number | null, d: Dunning): S3BillingState {
  if (days === null) return 'ok';
  if (days >= d.lock_after_days) return 'locked';
  if (days >= d.readonly_after_days) return 'readonly';
  return 'ok';
}

async function oldestDue(ctx: Ctx, userId: string): Promise<number | null> {
  const row = await ctx.env.DB.prepare(
    `SELECT MIN(due_at) AS due FROM s3_bills WHERE user_id = ?1 AND status = 'open'`,
  )
    .bind(userId)
    .first<{ due: number | null }>();
  return row?.due ?? null;
}

/** Puts an account in the state its unpaid bills call for (after a payment or a waiver). */
export async function refreshBillingState(ctx: Ctx, userId: string): Promise<S3BillingState> {
  const cfg = await ctx.config();
  const now = ctx.now();
  const state = stateFor(daysOverdue(await oldestDue(ctx, userId), now), cfg.s3_dunning);
  await ctx.env.DB.prepare(
    `UPDATE s3_accounts SET billing_state = ?2, updated_at = ?3 WHERE user_id = ?1 AND billing_state != ?2`,
  )
    .bind(userId, state, now)
    .run();
  return state;
}

async function audit(
  ctx: Ctx,
  actor: string | null,
  action: string,
  userId: string,
  meta: unknown,
) {
  await ctx.env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, created_at)
     VALUES (?1, ?2, ?3, 'user', ?4, ?5, ?6)`,
  )
    .bind(ulid(ctx.now()), actor, action, userId, JSON.stringify(meta), ctx.now())
    .run();
}

export interface S3DunningReport {
  changed: number;
  deleted: number;
  dryRun: string[];
}

/** Nightly: unpaid bills move their accounts to read-only, locked, then deleted (ADR-047). */
export async function runS3Dunning(ctx: Ctx): Promise<S3DunningReport> {
  const cfg = await ctx.config();
  const d = cfg.s3_dunning;
  const now = ctx.now();
  const DB = ctx.env.DB;
  const report: S3DunningReport = { changed: 0, deleted: 0, dryRun: [] };
  const { results } = await DB.prepare(
    `SELECT a.user_id, a.billing_state, a.status,
       (SELECT MIN(due_at) FROM s3_bills b WHERE b.user_id = a.user_id AND b.status = 'open') AS due,
       (SELECT COALESCE(SUM(total_idr), 0) FROM s3_bills b WHERE b.user_id = a.user_id AND b.status = 'open') AS owed
     FROM s3_accounts a
     WHERE a.billing_state != 'ok'
        OR EXISTS (SELECT 1 FROM s3_bills b WHERE b.user_id = a.user_id AND b.status = 'open' AND b.due_at <= ?1)
     LIMIT 500`,
  )
    .bind(now)
    .all<{
      user_id: string;
      billing_state: S3BillingState;
      status: string;
      due: number | null;
      owed: number;
    }>();
  for (const a of results) {
    if (a.status === 'deleting') continue;
    const days = daysOverdue(a.due, now);
    const state = stateFor(days, d);
    if (state !== a.billing_state) {
      await DB.prepare(
        `UPDATE s3_accounts SET billing_state = ?2, updated_at = ?3 WHERE user_id = ?1`,
      )
        .bind(a.user_id, state, now)
        .run();
      report.changed++;
    }
    if (days === null || a.due === null) continue;
    const deleteAt = a.due + d.delete_after_days * DAY_MS;
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
          await audit(ctx, null, 's3.dunning.delete.dry_run', a.user_id, { owedIdr: a.owed });
        report.dryRun.push(a.user_id);
        continue;
      }
      await DB.prepare(
        `UPDATE s3_accounts SET status = 'deleting', updated_at = ?2 WHERE user_id = ?1`,
      )
        .bind(a.user_id, now)
        .run();
      await audit(ctx, null, 's3.dunning.delete.live', a.user_id, { owedIdr: a.owed });
      await ctx.env.CLEANUP_QUEUE.send({ type: 's3_purge', userId: a.user_id });
      report.deleted++;
      continue;
    }
    for (const day of d.notify_days_after) {
      if (days < day || days > day + 1) continue;
      if (!(await onceKey(ctx, `s3_dunning:${a.user_id}:${a.due}:${day}`))) continue;
      const stage =
        days >= d.delete_after_days - 1
          ? 'delete_warning'
          : days >= d.lock_after_days
            ? 'locked'
            : days >= d.readonly_after_days
              ? 'readonly'
              : 'due';
      await notify(ctx, a.user_id, 's3_dunning', { stage, days, deleteAt, owedIdr: a.owed });
    }
  }
  return report;
}

/** Operator: a bill nobody has to pay (with the reason, in the audit log). */
export async function waiveS3Bill(
  ctx: Ctx,
  actor: string,
  billId: string,
  reason: string | undefined,
): Promise<void> {
  const why = reason?.trim() ?? '';
  if (why.length < 5) throw new AppError('VALIDATION', 'a reason is required', { field: 'reason' });
  const row = await ctx.env.DB.prepare(
    `UPDATE s3_bills SET status = 'waived', waived_reason = ?2
     WHERE id = ?1 AND status IN ('open', 'carried') RETURNING user_id, total_idr`,
  )
    .bind(billId, why.slice(0, 500))
    .first<{ user_id: string; total_idr: number }>();
  if (!row) throw new AppError('NOT_FOUND', 'no unpaid bill with this id');
  await audit(ctx, actor, 's3.bill_waived', row.user_id, {
    billId,
    totalIdr: row.total_idr,
    reason: why,
  });
  await refreshBillingState(ctx, row.user_id);
}

export interface S3BillDto {
  id: string;
  period: string;
  gibMonths: number;
  egressBytes: number;
  lines: S3BillLine[];
  totalIdr: number;
  status: S3BillStatus;
  dueAt: number | null;
  paidAt: number | null;
  createdAt: number;
}

/** Prices, this month so far, and the bills: for the /s3 page and the operator. */
export async function s3BillingView(ctx: Ctx, userId: string) {
  const p = await prices(ctx);
  const now = ctx.now();
  const period = s3Period(now);
  const DB = ctx.env.DB;
  const [usage, { results }, account] = await Promise.all([
    DB.prepare(`SELECT gib_hours, egress_bytes FROM s3_usage WHERE user_id = ?1 AND period = ?2`)
      .bind(userId, period)
      .first<{ gib_hours: number; egress_bytes: number }>(),
    DB.prepare(
      `SELECT id, period, gib_months, egress_bytes, lines_json, subtotal_idr, total_idr, status, due_at,
         paid_at, created_at
       FROM s3_bills WHERE user_id = ?1 ORDER BY period DESC LIMIT 12`,
    )
      .bind(userId)
      .all<{
        id: string;
        period: string;
        gib_months: number;
        egress_bytes: number;
        lines_json: string;
        subtotal_idr: number;
        total_idr: number;
        status: S3BillStatus;
        due_at: number | null;
        paid_at: number | null;
        created_at: number;
      }>(),
    DB.prepare(`SELECT billing_state FROM s3_accounts WHERE user_id = ?1`)
      .bind(userId)
      .first<{ billing_state: S3BillingState }>(),
  ]);
  const soFar = usageLines(period, usage?.gib_hours ?? 0, usage?.egress_bytes ?? 0, p);
  const open = results.filter((b) => b.status === 'open');
  return {
    prices: p,
    billingState: account?.billing_state ?? 'ok',
    current: {
      period,
      gibMonths: soFar.gibMonths,
      egressBytes: usage?.egress_bytes ?? 0,
      estimateIdr: await withTax(ctx, sum(soFar.lines)),
    },
    bills: results.map((b): S3BillDto => ({
      id: b.id,
      period: b.period,
      gibMonths: b.gib_months,
      egressBytes: b.egress_bytes,
      lines: JSON.parse(b.lines_json) as S3BillLine[],
      totalIdr: b.total_idr,
      status: b.status,
      dueAt: b.due_at,
      paidAt: b.paid_at,
      createdAt: b.created_at,
    })),
    outstanding: {
      billIds: open.map((b) => b.id),
      totalIdr: open.length
        ? await withTax(
            ctx,
            open.reduce((s, b) => s + b.subtotal_idr, 0),
          )
        : 0,
      dueAt: open.reduce<number | null>(
        (m, b) => (b.due_at !== null && (m === null || b.due_at < m) ? b.due_at : m),
        null,
      ),
    },
  };
}
