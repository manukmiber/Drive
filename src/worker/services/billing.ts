// Billing (SPEC §12): Saldo Zeiko (append-only ledger), top-ups through the PaymentProvider adapter,
// subscriptions (upgrade pro-rata now, downgrade next period), add-ons, compress packs, numbered
// invoices, auto-renewal and the dunning cycle. Every money movement is one atomic db.batch; the
// wallet's CHECK (balance >= 0) is what rejects overdrafts.
import { DAY_MS } from '../../shared/constants';
import type { PaymentStatus } from '../../shared/enums';
import { formatBytes } from '../../shared/format';
import { addBillingMonth, wibDate } from '../../shared/time';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { log } from '../lib/log';
import { ensurePersonalSpace } from './accounts';
import { notificationStmt, notify } from './notify';

type Stmt = D1PreparedStatement;

// ───────────────────────── catalog ─────────────────────────
export interface PlanRow {
  code: string;
  name: string;
  kind: 'personal' | 'family';
  price_idr: number;
  storage_bytes: number;
  compress_quota: number;
  max_members: number;
  max_file_bytes: number;
  active: number;
}

interface AddonRow {
  code: string;
  name: string;
  price_idr: number;
  storage_bytes: number;
  active: number;
}

export async function plan(ctx: Ctx, code: string): Promise<PlanRow> {
  const p = await ctx.env.DB.prepare('SELECT * FROM plans WHERE code = ?1')
    .bind(code)
    .first<PlanRow>();
  if (!p || !p.active) throw new AppError('NOT_FOUND', 'plan not found');
  return p;
}

// ───────────────────────── wallet ─────────────────────────
export async function walletBalance(ctx: Ctx, userId: string): Promise<number> {
  const w = await ctx.env.DB.prepare('SELECT balance_idr FROM wallets WHERE user_id = ?1')
    .bind(userId)
    .first<{ balance_idr: number }>();
  return w?.balance_idr ?? 0;
}

/** Statements that move `delta` (negative = debit) and append the ledger row. */
export function walletStmts(
  ctx: Ctx,
  userId: string,
  delta: number,
  reason: string,
  ref: string | null,
): Stmt[] {
  const now = ctx.now();
  const DB = ctx.env.DB;
  return [
    DB.prepare(
      'INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?1, 0, ?2) ON CONFLICT DO NOTHING',
    ).bind(userId, now),
    DB.prepare(
      'UPDATE wallets SET balance_idr = balance_idr + ?2, updated_at = ?3 WHERE user_id = ?1',
    ).bind(userId, delta, now),
    DB.prepare(
      `INSERT INTO wallet_ledger (id, user_id, delta_idr, balance_after, reason, ref, created_at)
       SELECT ?1, ?2, ?3, balance_idr, ?4, ?5, ?6 FROM wallets WHERE user_id = ?2`,
    ).bind(ulid(now), userId, delta, reason, ref, now),
  ];
}

export async function runMoneyBatch(ctx: Ctx, stmts: Stmt[], need: number): Promise<void> {
  try {
    await ctx.env.DB.batch(stmts);
  } catch (e) {
    if (/CHECK constraint failed/i.test(String(e))) {
      throw new AppError('INSUFFICIENT_BALANCE', 'saldo tidak cukup', { needIdr: need });
    }
    throw e;
  }
}

// ───────────────────────── invoices ─────────────────────────
export interface InvoiceLine {
  label: string;
  amountIdr: number;
}

export async function invoiceStmts(
  ctx: Ctx,
  userId: string,
  lines: InvoiceLine[],
  paymentId: string | null,
): Promise<{ id: string; total: number; stmts: Stmt[] }> {
  const cfg = await ctx.config();
  const subtotal = lines.reduce((s, l) => s + l.amountIdr, 0);
  const tax = Math.round((subtotal * cfg.tax_rate_pct) / 100);
  const total = subtotal + tax;
  const now = ctx.now();
  const ym = wibDate(now).replace(/-/g, '').slice(0, 6);
  const counter = `invoice:${ym}`;
  const id = ulid(now);
  const DB = ctx.env.DB;
  return {
    id,
    total,
    stmts: [
      DB.prepare(
        'INSERT INTO counters (name, value) VALUES (?1, 1) ON CONFLICT (name) DO UPDATE SET value = value + 1',
      ).bind(counter),
      DB.prepare(
        `INSERT INTO invoices (id, number, user_id, lines_json, subtotal_idr, tax_idr, total_idr, status, payment_id, issued_at)
         SELECT ?1, 'ZK-' || ?2 || '-' || printf('%06d', value), ?3, ?4, ?5, ?6, ?7, 'paid', ?8, ?9 FROM counters WHERE name = ?10`,
      ).bind(id, ym, userId, JSON.stringify(lines), subtotal, tax, total, paymentId, now, counter),
    ],
  };
}

/** Recomputes a pool's quota from its live subscription (plan + add-ons). */
export function poolLimitStmt(ctx: Ctx, poolId: string): Stmt {
  return ctx.env.DB.prepare(
    `UPDATE storage_pools SET limit_bytes = COALESCE((
       SELECT p.storage_bytes + COALESCE((SELECT SUM(a.storage_bytes * sa.qty) FROM subscription_addons sa
         JOIN addons a ON a.code = sa.addon_code
         WHERE sa.subscription_id = s.id AND (sa.ends_at IS NULL OR sa.ends_at > ?2)), 0)
       FROM subscriptions s JOIN plans p ON p.code = s.plan_code
       WHERE s.pool_id = storage_pools.id AND s.status IN ('active', 'grace', 'readonly', 'suspended')
       ORDER BY s.created_at DESC LIMIT 1), 0) + bonus_bytes, updated_at = ?2
     WHERE id = ?1`,
  ).bind(poolId, ctx.now());
}

export async function afterInvoice(
  ctx: Ctx,
  userId: string,
  invoiceId: string,
  summary: string,
): Promise<void> {
  const inv = await ctx.env.DB.prepare('SELECT number, total_idr FROM invoices WHERE id = ?1')
    .bind(invoiceId)
    .first<{ number: string; total_idr: number }>();
  if (inv)
    await notify(ctx, userId, 'invoice', {
      invoiceId,
      number: inv.number,
      totalIdr: inv.total_idr,
      summary,
    });
}

// ───────────────────────── subscriptions ─────────────────────────
export interface SubRow {
  id: string;
  pool_id: string;
  payer_user_id: string;
  plan_code: string;
  next_plan_code: string | null;
  status: string;
  period_start: number;
  period_end: number;
  anchor_day: number;
  auto_renew: number;
  cancel_at_period_end: number;
  status_changed_at: number;
}

const LIVE = `('active', 'grace', 'readonly', 'suspended')`;

export async function currentSubscription(ctx: Ctx, poolId: string): Promise<SubRow | null> {
  return ctx.env.DB.prepare(
    `SELECT * FROM subscriptions WHERE pool_id = ?1 AND status IN ${LIVE} ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(poolId)
    .first<SubRow>();
}

async function ownPool(ctx: Ctx, userId: string): Promise<string> {
  const space = await ensurePersonalSpace(ctx, userId);
  const pool = await ctx.env.DB.prepare(
    'SELECT owner_type, owner_id FROM storage_pools WHERE id = ?1',
  )
    .bind(space.poolId)
    .first<{ owner_type: string; owner_id: string }>();
  if (pool?.owner_type === 'family') {
    // The family owner pays for (and adds space to) the shared pool; members can't.
    const fam = await ctx.env.DB.prepare('SELECT owner_id FROM families WHERE id = ?1')
      .bind(pool.owner_id)
      .first<{ owner_id: string }>();
    if (fam?.owner_id === userId) return space.poolId;
  }
  if (pool?.owner_type !== 'user' || pool.owner_id !== userId) {
    // Family members use the family pool; only the family owner pays (Fase 8).
    throw new AppError('FORBIDDEN', 'storage is managed by your family plan', {
      reason: 'FAMILY_MEMBER',
    });
  }
  return space.poolId;
}

export function wibAnchorDay(ms: number): number {
  return new Date(ms + 7 * 3600_000).getUTCDate();
}

/** Remaining fraction of the current period, for pro-rata charges (rounded up to whole rupiah). */
export function proRata(priceIdr: number, sub: SubRow, now: number): number {
  const total = sub.period_end - sub.period_start;
  const left = Math.max(0, sub.period_end - now);
  return total > 0 ? Math.ceil((priceIdr * left) / total) : priceIdr;
}

export type PlanChange =
  | { kind: 'subscribed' | 'upgraded' | 'reactivated'; chargedIdr: number; invoiceId: string }
  | { kind: 'downgrade_scheduled' | 'downgrade_cancelled'; chargedIdr: 0 };

/** Buys or changes the personal plan, paid from Saldo (SPEC §12.4). */
export async function choosePlan(ctx: Ctx, userId: string, planCode: string): Promise<PlanChange> {
  const p = await plan(ctx, planCode);
  if (p.kind !== 'personal') {
    // Family plans: the family pool (creating the family on first purchase) — services/family.ts.
    const { chooseFamilyPlan } = await import('./family');
    return chooseFamilyPlan(ctx, userId, p);
  }
  const inFamily = await ctx.env.DB.prepare('SELECT role FROM family_members WHERE user_id = ?1')
    .bind(userId)
    .first<{ role: string }>();
  if (inFamily) {
    throw new AppError('CONFLICT', 'storage is managed by your family plan', {
      reason: inFamily.role === 'owner' ? 'FAMILY_OWNER' : 'FAMILY_MEMBER',
    });
  }
  const poolId = await ownPool(ctx, userId);
  return changePlanForPool(ctx, userId, poolId, p);
}

/** Subscribe / reactivate / upgrade / schedule a downgrade on an existing pool. */
export async function changePlanForPool(
  ctx: Ctx,
  userId: string,
  poolId: string,
  p: PlanRow,
): Promise<PlanChange> {
  const sub = await currentSubscription(ctx, poolId);
  const now = ctx.now();
  const DB = ctx.env.DB;

  if (!sub || sub.status !== 'active') {
    // New subscription, or paying an overdue one (any time before deletion → full restore).
    const anchor = wibAnchorDay(now);
    const subId = ulid(now);
    const inv = await invoiceStmts(
      ctx,
      userId,
      [
        {
          label: `Paket ${p.name} (${formatBytes(p.storage_bytes)}) · 1 bulan`,
          amountIdr: p.price_idr,
        },
      ],
      null,
    );
    const stmts: Stmt[] = [...walletStmts(ctx, userId, -inv.total, 'plan', inv.id)];
    if (sub) {
      stmts.push(
        DB.prepare(
          `UPDATE subscriptions SET status = 'cancelled', status_changed_at = ?2, updated_at = ?2 WHERE id = ?1`,
        ).bind(sub.id, now),
        DB.prepare(
          'UPDATE subscription_addons SET ends_at = ?2 WHERE subscription_id = ?1 AND ends_at IS NULL',
        ).bind(sub.id, now),
      );
    }
    stmts.push(
      DB.prepare(
        `INSERT INTO subscriptions (id, pool_id, payer_user_id, plan_code, status, period_start, period_end, anchor_day,
           auto_renew, cancel_at_period_end, status_changed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, 1, 0, ?5, ?5, ?5)`,
      ).bind(subId, poolId, userId, p.code, now, addBillingMonth(now, anchor), anchor),
      poolLimitStmt(ctx, poolId),
      ...inv.stmts,
    );
    await runMoneyBatch(ctx, stmts, inv.total);
    await grantPlanCredits(ctx, userId, p, addBillingMonth(now, anchor), subId);
    await afterInvoice(ctx, userId, inv.id, `Paket ${p.name} aktif.`);
    return { kind: sub ? 'reactivated' : 'subscribed', chargedIdr: inv.total, invoiceId: inv.id };
  }

  const cur = await plan(ctx, sub.plan_code).catch(() => null);
  if (sub.plan_code === p.code) {
    if (!sub.next_plan_code) throw new AppError('CONFLICT', 'already on this plan');
    await DB.prepare(
      'UPDATE subscriptions SET next_plan_code = NULL, updated_at = ?2 WHERE id = ?1',
    )
      .bind(sub.id, now)
      .run();
    return { kind: 'downgrade_cancelled', chargedIdr: 0 };
  }
  if (cur && p.price_idr < cur.price_idr) {
    await DB.prepare('UPDATE subscriptions SET next_plan_code = ?2, updated_at = ?3 WHERE id = ?1')
      .bind(sub.id, p.code, now)
      .run();
    return { kind: 'downgrade_scheduled', chargedIdr: 0 };
  }
  // Upgrade: immediate, pay the difference for the remaining days.
  const diff = proRata(p.price_idr - (cur?.price_idr ?? 0), sub, now);
  const days = Math.ceil((sub.period_end - now) / DAY_MS);
  const inv = await invoiceStmts(
    ctx,
    userId,
    [{ label: `Upgrade ke ${p.name} · pro-rata ${days} hari`, amountIdr: diff }],
    null,
  );
  await runMoneyBatch(
    ctx,
    [
      ...walletStmts(ctx, userId, -inv.total, 'upgrade', inv.id),
      DB.prepare(
        'UPDATE subscriptions SET plan_code = ?2, next_plan_code = NULL, updated_at = ?3 WHERE id = ?1',
      ).bind(sub.id, p.code, now),
      poolLimitStmt(ctx, poolId),
      ...inv.stmts,
    ],
    inv.total,
  );
  if (cur)
    await grantPlanCredits(
      ctx,
      userId,
      { ...p, compress_quota: Math.max(0, p.compress_quota - cur.compress_quota) },
      sub.period_end,
      sub.id,
    );
  await afterInvoice(ctx, userId, inv.id, `Paket naik ke ${p.name}.`);
  return { kind: 'upgraded', chargedIdr: inv.total, invoiceId: inv.id };
}

export async function setAutoRenew(
  ctx: Ctx,
  userId: string,
  cancelAtPeriodEnd: boolean,
): Promise<void> {
  const poolId = await ownPool(ctx, userId);
  const sub = await currentSubscription(ctx, poolId);
  if (!sub) throw new AppError('NOT_FOUND', 'no subscription');
  await ctx.env.DB.prepare(
    'UPDATE subscriptions SET cancel_at_period_end = ?2, updated_at = ?3 WHERE id = ?1',
  )
    .bind(sub.id, cancelAtPeriodEnd ? 1 : 0, ctx.now())
    .run();
}

export async function buyAddon(
  ctx: Ctx,
  userId: string,
  addonCode: string,
): Promise<{ chargedIdr: number; invoiceId: string }> {
  const a = await ctx.env.DB.prepare('SELECT * FROM addons WHERE code = ?1')
    .bind(addonCode)
    .first<AddonRow>();
  if (!a || !a.active) throw new AppError('NOT_FOUND', 'add-on not found');
  const poolId = await ownPool(ctx, userId);
  const sub = await currentSubscription(ctx, poolId);
  if (!sub || sub.status !== 'active')
    throw new AppError('CONFLICT', 'an active plan is required', { reason: 'NO_PLAN' });
  const now = ctx.now();
  const charge = proRata(a.price_idr, sub, now);
  const inv = await invoiceStmts(
    ctx,
    userId,
    [{ label: `${a.name} · sisa periode`, amountIdr: charge }],
    null,
  );
  await runMoneyBatch(
    ctx,
    [
      ...walletStmts(ctx, userId, -inv.total, 'addon', inv.id),
      ctx.env.DB.prepare(
        `INSERT INTO subscription_addons (id, subscription_id, addon_code, qty, cancel_at_period_end, starts_at) VALUES (?1, ?2, ?3, 1, 0, ?4)`,
      ).bind(ulid(now), sub.id, a.code, now),
      poolLimitStmt(ctx, poolId),
      ...inv.stmts,
    ],
    inv.total,
  );
  await afterInvoice(ctx, userId, inv.id, `${a.name} aktif.`);
  return { chargedIdr: inv.total, invoiceId: inv.id };
}

export async function cancelAddon(
  ctx: Ctx,
  userId: string,
  id: string,
  cancel: boolean,
): Promise<void> {
  const poolId = await ownPool(ctx, userId);
  const res = await ctx.env.DB.prepare(
    `UPDATE subscription_addons SET cancel_at_period_end = ?3 WHERE id = ?1 AND ends_at IS NULL
       AND subscription_id IN (SELECT id FROM subscriptions WHERE pool_id = ?2)`,
  )
    .bind(id, poolId, cancel ? 1 : 0)
    .run();
  if (!res.meta.changes) throw new AppError('NOT_FOUND', 'add-on not found');
}

export async function buyCompressPack(
  ctx: Ctx,
  userId: string,
  code: string,
): Promise<{ chargedIdr: number; invoiceId: string }> {
  const pack = await ctx.env.DB.prepare(
    'SELECT * FROM compress_packs WHERE code = ?1 AND active = 1',
  )
    .bind(code)
    .first<{ code: string; name: string; price_idr: number; credits: number; ttl_days: number }>();
  if (!pack) throw new AppError('NOT_FOUND', 'pack not found');
  const now = ctx.now();
  const inv = await invoiceStmts(
    ctx,
    userId,
    [{ label: `${pack.name} · ${pack.credits} kompres`, amountIdr: pack.price_idr }],
    null,
  );
  await runMoneyBatch(
    ctx,
    [
      ...walletStmts(ctx, userId, -inv.total, 'compress_pack', inv.id),
      ctx.env.DB.prepare(
        `INSERT INTO credit_ledger (id, user_id, delta, remaining, source, ref, expires_at, created_at) VALUES (?1, ?2, ?3, ?3, 'pack', ?4, ?5, ?6)`,
      ).bind(ulid(now), userId, pack.credits, inv.id, now + pack.ttl_days * DAY_MS, now),
      ...inv.stmts,
    ],
    inv.total,
  );
  await afterInvoice(ctx, userId, inv.id, `${pack.credits} kredit kompres ditambahkan.`);
  return { chargedIdr: inv.total, invoiceId: inv.id };
}

/** Monthly compress quota of a plan: granted per period, expires at period end (SPEC §11). */
export async function grantPlanCredits(
  ctx: Ctx,
  userId: string,
  p: Pick<PlanRow, 'compress_quota'>,
  expiresAt: number,
  ref: string,
): Promise<void> {
  if (p.compress_quota <= 0) return;
  await ctx.env.DB.prepare(
    `INSERT INTO credit_ledger (id, user_id, delta, remaining, source, ref, expires_at, created_at) VALUES (?1, ?2, ?3, ?3, 'plan', ?4, ?5, ?6)`,
  )
    .bind(ulid(ctx.now()), userId, p.compress_quota, ref, expiresAt, ctx.now())
    .run();
}

// ───────────────────────── payments ─────────────────────────
export interface TopupResult {
  paymentId: string;
  amountIdr: number;
  feeIdr: number;
  checkoutUrl: string | null;
  qrString: string | null;
  expiresAt: number;
}

export type DirectPurpose =
  | { kind: 'plan'; code: string }
  | { kind: 'addon'; code: string }
  | { kind: 'compress'; code: string };

export async function createTopup(
  ctx: Ctx,
  user: { id: string; email: string },
  input: { amountIdr: number; method: string; then?: DirectPurpose | undefined },
): Promise<TopupResult> {
  const cfg = await ctx.config();
  if (ctx.adapters.payment.name === 'mock' && ctx.env.APP_ENV === 'production') {
    throw new AppError('PAYMENT_UNAVAILABLE', 'payment gateway not configured');
  }
  const method = cfg.payment_methods.find((m) => m.code === input.method && m.active);
  if (!method) throw new AppError('VALIDATION', 'unknown payment method', { field: 'method' });
  const min = Math.max(cfg.min_topup_idr, method.min_idr);
  if (!Number.isInteger(input.amountIdr) || input.amountIdr < min)
    throw new AppError('VALIDATION', 'amount below minimum', { minIdr: min });
  if (input.amountIdr > 10_000_000)
    throw new AppError('VALIDATION', 'amount too large', { maxIdr: 10_000_000 });
  const fee = method.fee_flat_idr + Math.ceil((input.amountIdr * method.fee_pct) / 100);
  const charged = cfg.payment_fee_paid_by === 'user' ? input.amountIdr + fee : input.amountIdr;
  const now = ctx.now();
  const paymentId = ulid(now);
  const charge = await ctx.adapters.payment.createCharge({
    paymentId,
    amountIdr: charged,
    method: method.code,
    description: input.then ? 'Pembayaran Zeiko' : 'Isi Saldo Zeiko',
    customerEmail: user.email,
  });
  await ctx.env.DB.prepare(
    `INSERT INTO payments (id, user_id, provider, provider_ref, method, amount_idr, fee_idr, status, purpose, purpose_ref, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?10, ?10)`,
  )
    .bind(
      paymentId,
      user.id,
      ctx.adapters.payment.name,
      charge.providerRef,
      method.code,
      charged,
      fee,
      input.then ? 'direct' : 'topup',
      input.then ? JSON.stringify(input.then) : null,
      now,
    )
    .run();
  return {
    paymentId,
    amountIdr: charged,
    feeIdr: fee,
    checkoutUrl: charge.checkoutUrl,
    qrString: charge.qrString,
    expiresAt: charge.expiresAt,
  };
}

interface PaymentRow {
  id: string;
  user_id: string;
  provider: string;
  amount_idr: number;
  fee_idr: number;
  status: PaymentStatus;
  purpose: string;
  purpose_ref: string | null;
}

const FORWARD: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ['paid', 'failed', 'expired'],
  // A late "paid" after expiry still credits the money the customer actually sent.
  expired: ['paid'],
  failed: [],
  paid: ['refunded'],
  refunded: [],
};

/**
 * Applies a verified gateway event. Idempotent: replays and out-of-order events are no-ops
 * (status only moves forward; the wallet credit is guarded by a unique ledger ref).
 */
export async function applyPaymentEvent(
  ctx: Ctx,
  provider: string,
  ev: { providerRef: string; status: PaymentStatus; amountIdr: number; raw: unknown },
): Promise<'applied' | 'ignored'> {
  const p = await ctx.env.DB.prepare(
    'SELECT * FROM payments WHERE provider = ?1 AND provider_ref = ?2',
  )
    .bind(provider, ev.providerRef)
    .first<PaymentRow>();
  if (!p) return 'ignored';
  if (!FORWARD[p.status].includes(ev.status)) return 'ignored';
  if (ev.status === 'paid' && ev.amountIdr !== p.amount_idr) {
    log.warn('payment_amount_mismatch', {
      paymentId: p.id,
      expected: p.amount_idr,
      got: ev.amountIdr,
    });
    await ctx.env.NOTIFY_QUEUE.send({
      type: 'admin_alert',
      text: `Nominal pembayaran ${p.id} tidak cocok (${ev.amountIdr} ≠ ${p.amount_idr})`,
    });
    return 'ignored';
  }
  const now = ctx.now();
  const DB = ctx.env.DB;
  const stmts: Stmt[] = [
    DB.prepare(
      `UPDATE payments SET status = ?2, paid_at = CASE WHEN ?2 = 'paid' THEN ?3 ELSE paid_at END, raw_json = ?4, updated_at = ?3 WHERE id = ?1 AND status = ?5`,
    ).bind(p.id, ev.status, now, JSON.stringify(ev.raw).slice(0, 8000), p.status),
  ];
  // Fee paid by the user is not credited; only the amount they meant to top up.
  const credit =
    p.amount_idr - ((await ctx.config()).payment_fee_paid_by === 'user' ? p.fee_idr : 0);
  if (ev.status === 'paid') {
    stmts.push(
      DB.prepare(
        'INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?1, 0, ?2) ON CONFLICT DO NOTHING',
      ).bind(p.user_id, now),
      DB.prepare(
        `UPDATE wallets SET balance_idr = balance_idr + ?2, updated_at = ?3 WHERE user_id = ?1
           AND NOT EXISTS (SELECT 1 FROM wallet_ledger WHERE reason = 'topup' AND ref = ?4)`,
      ).bind(p.user_id, credit, now, p.id),
      DB.prepare(
        `INSERT INTO wallet_ledger (id, user_id, delta_idr, balance_after, reason, ref, created_at)
         SELECT ?1, ?2, ?3, balance_idr, 'topup', ?4, ?5 FROM wallets WHERE user_id = ?2
           AND NOT EXISTS (SELECT 1 FROM wallet_ledger WHERE reason = 'topup' AND ref = ?4)`,
      ).bind(ulid(now), p.user_id, credit, p.id, now),
      notificationStmt(ctx, p.user_id, 'payment_paid', { paymentId: p.id, amountIdr: credit }).stmt,
    );
  }
  if (ev.status === 'refunded') stmts.push(...walletStmts(ctx, p.user_id, -credit, 'refund', p.id));
  const res = await DB.batch(stmts);
  if (!res[0]?.meta.changes) return 'ignored';

  if (ev.status === 'paid' && p.purpose === 'direct' && p.purpose_ref) {
    // "Bayar langsung": the money lands in Saldo first, then the purchase is made from it.
    const then = JSON.parse(p.purpose_ref) as DirectPurpose;
    try {
      if (then.kind === 'plan') await choosePlan(ctx, p.user_id, then.code);
      else if (then.kind === 'addon') await buyAddon(ctx, p.user_id, then.code);
      else await buyCompressPack(ctx, p.user_id, then.code);
    } catch (e) {
      log.warn('direct_purchase_failed', { paymentId: p.id, error: String(e) });
    }
  }
  return 'applied';
}

export async function expireStalePayments(ctx: Ctx): Promise<number> {
  const cfg = await ctx.config();
  const res = await ctx.env.DB.prepare(
    `UPDATE payments SET status = 'expired', updated_at = ?1 WHERE status = 'pending' AND created_at < ?2`,
  )
    .bind(ctx.now(), ctx.now() - cfg.pending_payment_ttl_minutes * 60_000)
    .run();
  return res.meta.changes;
}

// ───────────────────────── renewals & dunning (cron) ─────────────────────────
async function renewalPrice(
  ctx: Ctx,
  sub: SubRow,
): Promise<{ lines: InvoiceLine[]; planCode: string }> {
  const planCode = sub.next_plan_code ?? sub.plan_code;
  const p = await ctx.env.DB.prepare('SELECT * FROM plans WHERE code = ?1')
    .bind(planCode)
    .first<PlanRow>();
  const { results: addons } = await ctx.env.DB.prepare(
    `SELECT a.name, a.price_idr, sa.qty FROM subscription_addons sa JOIN addons a ON a.code = sa.addon_code
     WHERE sa.subscription_id = ?1 AND sa.ends_at IS NULL AND sa.cancel_at_period_end = 0`,
  )
    .bind(sub.id)
    .all<{ name: string; price_idr: number; qty: number }>();
  return {
    planCode,
    lines: [
      { label: `Paket ${p?.name ?? planCode} · 1 bulan`, amountIdr: p?.price_idr ?? 0 },
      ...addons.map((a) => ({
        label: `${a.name}${a.qty > 1 ? ` ×${a.qty}` : ''} · 1 bulan`,
        amountIdr: a.price_idr * a.qty,
      })),
    ],
  };
}

/** Renews due subscriptions from Saldo; unpaid ones enter `grace` (SPEC §12.4–12.5). */
export async function renewDueSubscriptions(
  ctx: Ctx,
  limit = 100,
): Promise<{ renewed: number; failed: number }> {
  const now = ctx.now();
  const DB = ctx.env.DB;
  const { results } = await DB.prepare(
    `SELECT * FROM subscriptions WHERE status = 'active' AND period_end <= ?1 LIMIT ?2`,
  )
    .bind(now, limit)
    .all<SubRow>();
  let renewed = 0;
  let failed = 0;
  for (const sub of results) {
    const toGrace = async (reason: string) => {
      await DB.batch([
        DB.prepare(
          `UPDATE subscriptions SET status = 'grace', status_changed_at = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'active'`,
        ).bind(sub.id, sub.period_end, now),
        notificationStmt(ctx, sub.payer_user_id, 'renewal_failed', {
          stage: 'grace',
          reason,
          deleteAt: sub.period_end + (await ctx.config()).dunning.delete_after_days * DAY_MS,
        }).stmt,
      ]);
      failed++;
    };
    if (sub.cancel_at_period_end || !sub.auto_renew) {
      await toGrace('cancelled');
      continue;
    }
    const { lines, planCode } = await renewalPrice(ctx, sub);
    const inv = await invoiceStmts(ctx, sub.payer_user_id, lines, null);
    const nextEnd = addBillingMonth(sub.period_end, sub.anchor_day);
    try {
      await runMoneyBatch(
        ctx,
        [
          ...walletStmts(ctx, sub.payer_user_id, -inv.total, 'renewal', inv.id),
          DB.prepare(
            `UPDATE subscriptions SET plan_code = ?2, next_plan_code = NULL, period_start = period_end, period_end = ?3, updated_at = ?4
             WHERE id = ?1 AND status = 'active' AND period_end = ?5`,
          ).bind(sub.id, planCode, nextEnd, now, sub.period_end),
          DB.prepare(
            'UPDATE subscription_addons SET ends_at = ?2 WHERE subscription_id = ?1 AND ends_at IS NULL AND cancel_at_period_end = 1',
          ).bind(sub.id, sub.period_end),
          poolLimitStmt(ctx, sub.pool_id),
          ...inv.stmts,
        ],
        inv.total,
      );
      const p = await DB.prepare('SELECT * FROM plans WHERE code = ?1')
        .bind(planCode)
        .first<PlanRow>();
      if (p) await grantPlanCredits(ctx, sub.payer_user_id, p, nextEnd, sub.id);
      await afterInvoice(ctx, sub.payer_user_id, inv.id, 'Paket diperpanjang.');
      renewed++;
    } catch (e) {
      if (e instanceof AppError && e.code === 'INSUFFICIENT_BALANCE') await toGrace('balance');
      else throw e;
    }
  }
  return { renewed, failed };
}

/** H-3 / H-1 reminders (once per subscription period and day). */
export async function sendRenewalReminders(ctx: Ctx): Promise<number> {
  const cfg = await ctx.config();
  const now = ctx.now();
  let sent = 0;
  for (const days of cfg.billing_reminder_days_before) {
    const { results } = await ctx.env.DB.prepare(
      `SELECT * FROM subscriptions WHERE status = 'active' AND auto_renew = 1 AND cancel_at_period_end = 0
         AND period_end > ?1 AND period_end <= ?2 LIMIT 500`,
    )
      .bind(now + (days - 1) * DAY_MS, now + days * DAY_MS)
      .all<SubRow>();
    for (const sub of results) {
      if (!(await onceKey(ctx, `remind:${sub.id}:${sub.period_end}:${days}`))) continue;
      const { lines } = await renewalPrice(ctx, sub);
      const p = await plan(ctx, sub.next_plan_code ?? sub.plan_code).catch(() => null);
      await notify(ctx, sub.payer_user_id, 'billing_reminder', {
        days,
        planName: p?.name ?? sub.plan_code,
        periodEnd: sub.period_end,
        amountIdr: lines.reduce((s, l) => s + l.amountIdr, 0),
        balanceIdr: await walletBalance(ctx, sub.payer_user_id),
      });
      sent++;
    }
  }
  return sent;
}

/** Idempotency marker for cron side effects; true the first time only. */
async function onceKey(ctx: Ctx, key: string): Promise<boolean> {
  const res = await ctx.env.DB.prepare(
    'INSERT INTO usage_counters (key, count, window_start, expires_at) VALUES (?1, 1, ?2, ?3) ON CONFLICT (key) DO NOTHING',
  )
    .bind(key, ctx.now(), ctx.now() + 90 * DAY_MS)
    .run();
  return res.meta.changes === 1;
}

export interface DunningReport {
  readonly: number;
  suspended: number;
  deleted: number;
  dryRun: Array<{ subscriptionId: string; poolId: string; files: number; bytes: number }>;
  notified: number;
}

/** Moves overdue subscriptions through grace → readonly → suspended → deleted (SPEC §12.5). */
export async function runDunning(ctx: Ctx): Promise<DunningReport> {
  const cfg = await ctx.config();
  const d = cfg.dunning;
  const now = ctx.now();
  const DB = ctx.env.DB;
  const report: DunningReport = { readonly: 0, suspended: 0, deleted: 0, dryRun: [], notified: 0 };
  const { results } = await DB.prepare(
    `SELECT * FROM subscriptions WHERE status IN ('grace', 'readonly', 'suspended') LIMIT 500`,
  ).all<SubRow>();
  for (const sub of results) {
    const days = Math.floor((now - sub.period_end) / DAY_MS);
    const deleteAt = sub.period_end + d.delete_after_days * DAY_MS;
    const move = async (to: string) => {
      const r = await DB.prepare(
        `UPDATE subscriptions SET status = ?2, status_changed_at = ?3, updated_at = ?3 WHERE id = ?1 AND status = ?4`,
      )
        .bind(sub.id, to, now, sub.status)
        .run();
      return r.meta.changes === 1;
    };
    if (days >= d.delete_after_days) {
      // Never delete while a payment is pending or a dispute (legal hold) exists.
      const pending = await DB.prepare(
        `SELECT 1 AS p FROM payments WHERE user_id = ?1 AND status = 'pending' LIMIT 1`,
      )
        .bind(sub.payer_user_id)
        .first();
      if (pending) continue;
      const stats = await DB.prepare(
        `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM nodes WHERE pool_id = ?1 AND kind = 'file'`,
      )
        .bind(sub.pool_id)
        .first<{ files: number; bytes: number }>();
      if (cfg.dunning_delete_mode === 'dry_run') {
        if (await onceKey(ctx, `dunning_dry:${sub.id}:${wibDate(now)}`)) {
          await audit(ctx, 'dunning.delete.dry_run', sub, stats);
        }
        report.dryRun.push({
          subscriptionId: sub.id,
          poolId: sub.pool_id,
          files: stats?.files ?? 0,
          bytes: stats?.bytes ?? 0,
        });
        continue;
      }
      if (await move('deleted')) {
        await audit(ctx, 'dunning.delete.live', sub, stats);
        await DB.prepare(`UPDATE storage_pools SET limit_bytes = 0, updated_at = ?2 WHERE id = ?1`)
          .bind(sub.pool_id, now)
          .run();
        await ctx.env.CLEANUP_QUEUE.send({
          type: 'purge_pool',
          poolId: sub.pool_id,
          dryRun: false,
        });
        report.deleted++;
      }
      continue;
    }
    if (days >= d.suspend_after_days && sub.status !== 'suspended') {
      if (await move('suspended')) report.suspended++;
    } else if (days >= d.readonly_after_days && sub.status === 'grace') {
      if (await move('readonly')) report.readonly++;
    }
    for (const day of d.notify_days_after) {
      if (days < day || days > day + 1) continue;
      if (!(await onceKey(ctx, `dunning:${sub.id}:${sub.period_end}:${day}`))) continue;
      const stage =
        days >= d.delete_after_days - 1
          ? 'delete_warning'
          : days >= d.suspend_after_days
            ? 'suspended'
            : days >= d.readonly_after_days
              ? 'readonly'
              : 'grace';
      // Family pools: every member is told, not just the payer (SPEC §9.3).
      const { results: members } = await DB.prepare(
        `SELECT m.user_id FROM family_members m JOIN families f ON f.id = m.family_id WHERE f.pool_id = ?1`,
      )
        .bind(sub.pool_id)
        .all<{ user_id: string }>();
      const recipients = new Set([sub.payer_user_id, ...members.map((m) => m.user_id)]);
      for (const u of recipients) await notify(ctx, u, 'dunning', { stage, deleteAt, days });
      report.notified++;
    }
  }
  return report;
}

async function audit(ctx: Ctx, action: string, sub: SubRow, meta: unknown): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?1, NULL, ?2, 'pool', ?3, ?4, ?5)`,
  )
    .bind(
      ulid(ctx.now()),
      action,
      sub.pool_id,
      JSON.stringify({ subscriptionId: sub.id, ...(meta as object) }),
      ctx.now(),
    )
    .run();
  log.info(action, { poolId: sub.pool_id, subscriptionId: sub.id });
}

// ───────────────────────── read models ─────────────────────────
export async function billingSummary(ctx: Ctx, userId: string) {
  const space = await ensurePersonalSpace(ctx, userId);
  const DB = ctx.env.DB;
  const sub = await currentSubscription(ctx, space.poolId);
  const [pool, balance, addons, pending, credits] = await Promise.all([
    DB.prepare(
      'SELECT owner_type, owner_id, limit_bytes, used_bytes, reserved_bytes FROM storage_pools WHERE id = ?1',
    )
      .bind(space.poolId)
      .first<{
        owner_type: string;
        owner_id: string;
        limit_bytes: number;
        used_bytes: number;
        reserved_bytes: number;
      }>(),
    walletBalance(ctx, userId),
    sub
      ? DB.prepare(
          `SELECT sa.id, sa.addon_code AS code, a.name, a.price_idr AS priceIdr, a.storage_bytes AS storageBytes, sa.qty, sa.cancel_at_period_end AS cancelAtPeriodEnd
           FROM subscription_addons sa JOIN addons a ON a.code = sa.addon_code WHERE sa.subscription_id = ?1 AND sa.ends_at IS NULL`,
        )
          .bind(sub.id)
          .all()
      : Promise.resolve({ results: [] }),
    DB.prepare(
      `SELECT id, amount_idr AS amountIdr, method, status, created_at AS createdAt FROM payments WHERE user_id = ?1 AND status = 'pending' ORDER BY created_at DESC LIMIT 5`,
    )
      .bind(userId)
      .all(),
    DB.prepare(
      `SELECT COALESCE(SUM(remaining), 0) AS n FROM credit_ledger WHERE user_id = ?1 AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?2)`,
    )
      .bind(userId, ctx.now())
      .first<{ n: number }>(),
  ]);
  const cfg = await ctx.config();
  return {
    balanceIdr: balance,
    managedByFamily: pool?.owner_type !== 'user' || pool.owner_id !== userId,
    storage: {
      limitBytes: pool?.limit_bytes ?? 0,
      usedBytes: pool?.used_bytes ?? 0,
      reservedBytes: pool?.reserved_bytes ?? 0,
    },
    subscription: sub && {
      id: sub.id,
      planCode: sub.plan_code,
      nextPlanCode: sub.next_plan_code,
      status: sub.status,
      periodStart: sub.period_start,
      periodEnd: sub.period_end,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
      readonlyAt: sub.period_end + cfg.dunning.readonly_after_days * DAY_MS,
      suspendAt: sub.period_end + cfg.dunning.suspend_after_days * DAY_MS,
      deleteAt: sub.period_end + cfg.dunning.delete_after_days * DAY_MS,
    },
    addons: addons.results,
    pendingPayments: pending.results,
    compressCredits: credits?.n ?? 0,
    paymentMethods: cfg.payment_methods
      .filter((m) => m.active)
      .map((m) => ({
        code: m.code,
        label: m.label,
        minIdr: Math.max(m.min_idr, cfg.min_topup_idr),
      })),
    minTopupIdr: cfg.min_topup_idr,
  };
}

export async function listLedger(ctx: Ctx, userId: string) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, delta_idr AS deltaIdr, balance_after AS balanceAfter, reason, ref, created_at AS createdAt
     FROM wallet_ledger WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 100`,
  )
    .bind(userId)
    .all();
  return results;
}

export async function listInvoices(ctx: Ctx, userId: string) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, number, total_idr AS totalIdr, status, issued_at AS issuedAt FROM invoices WHERE user_id = ?1 ORDER BY issued_at DESC LIMIT 100`,
  )
    .bind(userId)
    .all();
  return results;
}

export async function getInvoice(ctx: Ctx, userId: string, id: string) {
  const inv = await ctx.env.DB.prepare(
    `SELECT i.*, u.name AS user_name, u.email AS user_email FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.id = ?1 AND i.user_id = ?2`,
  )
    .bind(id, userId)
    .first<{
      id: string;
      number: string;
      lines_json: string;
      subtotal_idr: number;
      tax_idr: number;
      total_idr: number;
      status: string;
      issued_at: number;
      user_name: string;
      user_email: string;
    }>();
  if (!inv) throw new AppError('NOT_FOUND', 'invoice not found');
  const cfg = await ctx.config();
  return {
    id: inv.id,
    number: inv.number,
    lines: JSON.parse(inv.lines_json) as InvoiceLine[],
    subtotalIdr: inv.subtotal_idr,
    taxIdr: inv.tax_idr,
    taxRatePct: cfg.tax_rate_pct,
    totalIdr: inv.total_idr,
    status: inv.status,
    issuedAt: inv.issued_at,
    customer: { name: inv.user_name, email: inv.user_email },
  };
}

/**
 * Deletes a pool's content in bounded chunks (H+37, live mode only). Re-enqueues itself until done.
 * Blobs under legal hold survive because deleteOrphanBlob skips them.
 */
export async function purgePool(
  ctx: Ctx,
  poolId: string,
  chunk = 50,
): Promise<{ deleted: number; more: boolean }> {
  const sub = await ctx.env.DB.prepare(
    `SELECT status FROM subscriptions WHERE pool_id = ?1 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(poolId)
    .first<{ status: string }>();
  if (sub?.status !== 'deleted') return { deleted: 0, more: false }; // paid in the meantime
  const { results } = await ctx.env.DB.prepare(
    `SELECT n.id FROM nodes n JOIN nodes p ON p.id = n.parent_id WHERE n.pool_id = ?1 AND p.parent_id IS NULL LIMIT ?2`,
  )
    .bind(poolId, chunk)
    .all<{ id: string }>();
  const { deleteSubtree } = await import('./nodes');
  let deleted = 0;
  for (const r of results) deleted += (await deleteSubtree(ctx, r.id)).nodes;
  const more = results.length === chunk;
  if (more) await ctx.env.CLEANUP_QUEUE.send({ type: 'purge_pool', poolId, dryRun: false });
  return { deleted, more };
}
