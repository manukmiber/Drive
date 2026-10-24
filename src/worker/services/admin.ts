// Admin panel data & actions (SPEC §13.1). Every mutation needs a reason and lands in audit_logs.
// There is deliberately no "browse a user's files" capability: content is only reachable through an
// abuse report (services/reports.ts), and that access is audited too.
import { CONFIG_DEFAULTS, configSchema, type ConfigKey } from '../../shared/config-defaults';
import { DAY_MS, GIB } from '../../shared/constants';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { addBillingMonth } from '../../shared/time';
import { ensurePersonalSpace } from './accounts';
import { poolLimitStmt, wibAnchorDay } from './billing';
import { getConfig, setConfig } from './config';
import { setUserStatus } from './reports';
import { noticeEmail } from './email-templates';

async function audit(
  ctx: Ctx,
  actorId: string,
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
      actorId,
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

// ── Dashboard ──
export async function dashboard(ctx: Ctx, days = 30) {
  const DB = ctx.env.DB;
  const now = ctx.now();
  const since = now - days * DAY_MS;
  const cfg = await ctx.config();
  const [users, active, revenue, byPlan, storage, compressUsed, fees, scans, reports] =
    await Promise.all([
      DB.prepare(
        `SELECT COUNT(*) AS n, SUM(created_at >= ?1) AS fresh FROM users WHERE status != 'deleted'`,
      )
        .bind(since)
        .first<{ n: number; fresh: number }>(),
      DB.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE updated_at >= ?1`)
        .bind(since)
        .first<{ n: number }>(),
      DB.prepare(
        `SELECT reason, -SUM(delta_idr) AS idr, COUNT(*) AS n FROM wallet_ledger
       WHERE delta_idr < 0 AND created_at >= ?1 AND reason IN ('plan', 'upgrade', 'renewal', 'addon', 'compress_pack', 'ad') GROUP BY reason`,
      )
        .bind(since)
        .all<{ reason: string; idr: number; n: number }>(),
      DB.prepare(
        `SELECT s.plan_code AS plan, p.name, p.price_idr AS priceIdr, p.storage_bytes AS storageBytes, COUNT(*) AS subs,
              SUM(sp.used_bytes) AS usedBytes, SUM(sp.limit_bytes) AS limitBytes
       FROM subscriptions s JOIN plans p ON p.code = s.plan_code JOIN storage_pools sp ON sp.id = s.pool_id
       WHERE s.status IN ('active', 'grace', 'readonly', 'suspended') GROUP BY s.plan_code ORDER BY p.price_idr`,
      ).all<{
        plan: string;
        name: string;
        priceIdr: number;
        storageBytes: number;
        subs: number;
        usedBytes: number;
        limitBytes: number;
      }>(),
      DB.prepare(
        `SELECT COALESCE(SUM(used_bytes), 0) AS used, COALESCE(SUM(limit_bytes), 0) AS sold FROM storage_pools`,
      ).first<{ used: number; sold: number }>(),
      DB.prepare(
        `SELECT COALESCE(-SUM(delta), 0) AS n FROM credit_ledger WHERE delta < 0 AND created_at >= ?1`,
      )
        .bind(since)
        .first<{ n: number }>(),
      DB.prepare(
        `SELECT COALESCE(SUM(fee_idr), 0) AS idr FROM payments WHERE status = 'paid' AND paid_at >= ?1`,
      )
        .bind(since)
        .first<{ idr: number }>(),
      DB.prepare(
        `SELECT scan_status AS status, COUNT(*) AS n FROM blobs WHERE created_at >= ?1 GROUP BY scan_status`,
      )
        .bind(since)
        .all<{ status: string; n: number }>(),
      DB.prepare(
        `SELECT COUNT(*) AS open, SUM(sla_due_at < ?1) AS overdue FROM abuse_reports WHERE status IN ('open', 'in_review')`,
      )
        .bind(now)
        .first<{ open: number; overdue: number }>(),
    ]);
  const usd = cfg.usd_idr_rate;
  // Monthly cost estimate from Lampiran B: storage at the real usage + compress beyond the free tier.
  const storageCostIdr = Math.round(
    ((storage?.used ?? 0) / GIB) * cfg.r2_storage_usd_per_gb_month * usd,
  );
  const paidTransforms = Math.max(0, (compressUsed?.n ?? 0) - cfg.free_transforms_per_month);
  const compressCostIdr = Math.round(
    (paidTransforms / 1000) * cfg.image_transform_usd_per_1000 * usd,
  );
  const revenueIdr = revenue.results.reduce((s, r) => s + r.idr, 0);
  // Fixed costs for the period (Workers Paid and the like), pro rata over 30-day months.
  const fixedIdr = Math.round((cfg.fixed_costs_usd_per_month * usd * days) / 30);
  const plans = byPlan.results.map((p) => {
    const costPerSub = (p.storageBytes / GIB) * cfg.r2_storage_usd_per_gb_month * usd;
    return {
      ...p,
      revenueIdr: p.priceIdr * p.subs,
      costAtUsageIdr: Math.round(
        ((p.usedBytes ?? 0) / GIB) * cfg.r2_storage_usd_per_gb_month * usd,
      ),
      scenarios: cfg.usage_scenarios_pct.map((pct) => ({
        pct,
        marginIdr: Math.round(p.priceIdr - (costPerSub * pct) / 100),
      })),
      breakEvenUsagePct: costPerSub > 0 ? Math.round((p.priceIdr / costPerSub) * 100) : null,
    };
  });
  return {
    periodDays: days,
    users: { total: users?.n ?? 0, new: users?.fresh ?? 0, active: active?.n ?? 0 },
    revenue: { totalIdr: revenueIdr, byProduct: revenue.results },
    storage: { usedBytes: storage?.used ?? 0, soldBytes: storage?.sold ?? 0 },
    plans,
    compress: { used: compressUsed?.n ?? 0, freeQuota: cfg.free_transforms_per_month },
    costs: {
      storageIdr: storageCostIdr,
      compressIdr: compressCostIdr,
      paymentFeesIdr: fees?.idr ?? 0,
      fixedIdr,
      totalIdr: storageCostIdr + compressCostIdr + (fees?.idr ?? 0) + fixedIdr,
      note: 'Estimasi R2 storage + kompres (Lampiran B) + biaya gateway + biaya tetap (fixed_costs_usd_per_month). Operasi R2, Workers, D1, Containers, dan Email lihat tagihan Cloudflare; tarifnya di component_tariffs_usd.',
    },
    marginIdr: revenueIdr - (storageCostIdr + compressCostIdr + (fees?.idr ?? 0) + fixedIdr),
    assumptions: {
      usdIdrRate: usd,
      r2UsdPerGbMonth: cfg.r2_storage_usd_per_gb_month,
      qrisFeePct: cfg.payment_methods.find((m) => m.code === 'qris')?.fee_pct ?? 0,
      fixedUsdPerMonth: cfg.fixed_costs_usd_per_month,
    },
    scans: scans.results,
    reports: { open: reports?.open ?? 0, overdue: reports?.overdue ?? 0 },
  };
}

// ── Users ──
export async function searchUsers(ctx: Ctx, q: string) {
  const like = `%${q.trim().toLowerCase().replace(/[%_]/g, '')}%`;
  const { results } = await ctx.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at AS createdAt,
            sp.limit_bytes AS limitBytes, sp.used_bytes AS usedBytes, sp.bonus_bytes AS bonusBytes,
            (SELECT plan_code FROM subscriptions s WHERE s.pool_id = sp.id ORDER BY created_at DESC LIMIT 1) AS planCode,
            (SELECT status FROM subscriptions s WHERE s.pool_id = sp.id ORDER BY created_at DESC LIMIT 1) AS subStatus,
            COALESCE(w.balance_idr, 0) AS balanceIdr
     FROM users u LEFT JOIN storage_pools sp ON sp.owner_type = 'user' AND sp.owner_id = u.id
     LEFT JOIN wallets w ON w.user_id = u.id
     WHERE (?1 = '%%' OR lower(u.email) LIKE ?1 OR lower(u.name) LIKE ?1 OR u.id = ?2)
     ORDER BY u.created_at DESC LIMIT 50`,
  )
    .bind(like, q.trim())
    .all();
  return results;
}

/** D1 binds at most 100 values per statement. */
const IDS_PER_QUERY = 90;

/**
 * Drive's side of the people the relay lists on Zeiko Accounts (ADR-040): for each Zeiko Account
 * id that has a Drive user, that user's plan, storage, credit (`balanceIdr`, ADR-041) and standing. Ids with no Drive user
 * are left out. Nothing about anybody's files.
 */
export async function peopleByZeikoId(ctx: Ctx, zeikoIds: string[]) {
  const ids = [...new Set(zeikoIds.filter((id) => typeof id === 'string' && id.length <= 128))];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
    const part = ids.slice(i, i + IDS_PER_QUERY);
    const { results } = await ctx.env.DB.prepare(
      `SELECT a.account_id AS zeikoId, u.id, u.email, u.name, u.role, u.status, u.created_at AS createdAt,
              sp.limit_bytes AS limitBytes, sp.used_bytes AS usedBytes, sp.bonus_bytes AS bonusBytes,
              s.plan_code AS planCode, s.status AS subStatus, s.period_end AS periodEnd, p.name AS planName,
              COALESCE(w.balance_idr, 0) AS balanceIdr
       FROM accounts a JOIN users u ON u.id = a.user_id
       LEFT JOIN storage_pools sp ON sp.owner_type = 'user' AND sp.owner_id = u.id
       LEFT JOIN subscriptions s ON s.id = (SELECT id FROM subscriptions WHERE pool_id = sp.id
                                            ORDER BY created_at DESC LIMIT 1)
       LEFT JOIN plans p ON p.code = s.plan_code
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE a.provider_id = 'zeiko' AND a.account_id IN (${part.map((_, j) => `?${j + 1}`).join(', ')})`,
    )
      .bind(...part)
      .all();
    for (const row of results as Array<Record<string, unknown>>) {
      const { zeikoId, ...rest } = row;
      out[String(zeikoId)] = rest;
    }
  }
  return out;
}

export async function setUserSuspended(
  ctx: Ctx,
  actorId: string,
  userId: string,
  suspended: boolean,
  reason: string | undefined,
): Promise<void> {
  const r = requireReason(reason);
  if (userId === actorId) throw new AppError('BAD_REQUEST', 'cannot suspend yourself');
  await setUserStatus(ctx, userId, suspended ? 'suspended' : 'active');
  await audit(ctx, actorId, suspended ? 'user.suspend' : 'user.unsuspend', 'user', userId, {
    reason: r,
  });
}

export async function adjustBalance(
  ctx: Ctx,
  actorId: string,
  userId: string,
  deltaIdr: number,
  reason: string | undefined,
): Promise<number> {
  const r = requireReason(reason);
  if (!Number.isInteger(deltaIdr) || deltaIdr === 0 || Math.abs(deltaIdr) > 10_000_000)
    throw new AppError('VALIDATION', 'invalid amount');
  const now = ctx.now();
  const DB = ctx.env.DB;
  try {
    await DB.batch([
      DB.prepare(
        'INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?1, 0, ?2) ON CONFLICT DO NOTHING',
      ).bind(userId, now),
      DB.prepare(
        'UPDATE wallets SET balance_idr = balance_idr + ?2, updated_at = ?3 WHERE user_id = ?1',
      ).bind(userId, deltaIdr, now),
      DB.prepare(
        `INSERT INTO wallet_ledger (id, user_id, delta_idr, balance_after, reason, ref, created_at)
         SELECT ?1, ?2, ?3, balance_idr, 'adjust', ?4, ?5 FROM wallets WHERE user_id = ?2`,
      ).bind(ulid(now), userId, deltaIdr, `admin:${actorId}`, now),
    ]);
  } catch (e) {
    if (/CHECK constraint/i.test(String(e)))
      throw new AppError('INSUFFICIENT_BALANCE', 'balance would go negative');
    throw e;
  }
  await audit(ctx, actorId, 'wallet.adjust', 'user', userId, { deltaIdr, reason: r });
  const w = await DB.prepare('SELECT balance_idr FROM wallets WHERE user_id = ?1')
    .bind(userId)
    .first<{ balance_idr: number }>();
  return w?.balance_idr ?? 0;
}

/** Bonus storage on top of the plan (e.g. compensation). Recomputes the pool limit. */
export async function setBonusQuota(
  ctx: Ctx,
  actorId: string,
  userId: string,
  bonusBytes: number,
  reason: string | undefined,
): Promise<void> {
  const r = requireReason(reason);
  if (!Number.isInteger(bonusBytes) || bonusBytes < 0 || bonusBytes > 10 * 1024 * GIB)
    throw new AppError('VALIDATION', 'invalid bonus');
  const pool = await ctx.env.DB.prepare(
    `SELECT id, bonus_bytes FROM storage_pools WHERE owner_type = 'user' AND owner_id = ?1`,
  )
    .bind(userId)
    .first<{ id: string; bonus_bytes: number }>();
  if (!pool) throw new AppError('NOT_FOUND', 'user has no storage pool');
  await ctx.env.DB.prepare(
    `UPDATE storage_pools SET limit_bytes = MAX(0, limit_bytes - bonus_bytes + ?2), bonus_bytes = ?2, updated_at = ?3 WHERE id = ?1`,
  )
    .bind(pool.id, bonusBytes, ctx.now())
    .run();
  await audit(ctx, actorId, 'quota.bonus', 'user', userId, {
    from: pool.bonus_bytes,
    to: bonusBytes,
    reason: r,
  });
}

export async function setUserRole(
  ctx: Ctx,
  actorId: string,
  userId: string,
  role: 'user' | 'moderator' | 'admin',
  reason: string | undefined,
): Promise<void> {
  const r = requireReason(reason);
  if (userId === actorId) throw new AppError('BAD_REQUEST', 'cannot change your own role');
  await ctx.env.DB.prepare('UPDATE users SET role = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(userId, role, ctx.now())
    .run();
  await audit(ctx, actorId, 'user.role', 'user', userId, { role, reason: r });
}

// ── Scanner ──
export async function scannerStats(ctx: Ctx) {
  const since = ctx.now() - 7 * DAY_MS;
  const [byStatus, errors, blocked] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT scan_status AS status, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE created_at >= ?1 GROUP BY scan_status`,
    )
      .bind(since)
      .all<{ status: string; n: number; bytes: number }>(),
    ctx.env.DB.prepare(
      `SELECT id, size, scan_status AS status, scan_detail AS detail, scan_attempts AS attempts, created_at AS createdAt
       FROM blobs WHERE scan_status IN ('error', 'infected', 'quarantined') OR (scan_status = 'pending' AND created_at < ?1)
       ORDER BY created_at DESC LIMIT 50`,
    )
      .bind(ctx.now() - 3600_000)
      .all(),
    ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM blocked_hashes`).first<{ n: number }>(),
  ]);
  const total = byStatus.results.reduce((s, r) => s + r.n, 0);
  const err = byStatus.results.find((r) => r.status === 'error')?.n ?? 0;
  return {
    last7Days: byStatus.results,
    errorRatePct: total ? Math.round((err / total) * 1000) / 10 : 0,
    recent: errors.results,
    blockedHashes: blocked?.n ?? 0,
    scanner: ctx.adapters.scanner.name,
  };
}

export async function retryScan(ctx: Ctx, actorId: string, blobId: string): Promise<void> {
  await ctx.env.DB.prepare(
    `UPDATE blobs SET scan_status = 'pending', scan_attempts = 0 WHERE id = ?1 AND scan_status = 'error'`,
  )
    .bind(blobId)
    .run();
  await ctx.env.SCAN_QUEUE.send({ type: 'scan', blobId });
  await audit(ctx, actorId, 'scan.retry', 'blob', blobId, null);
}

// ── Config & catalog ──
export async function configView(ctx: Ctx) {
  const current = await getConfig(ctx.env, ctx.now());
  const { results } = await ctx.env.DB.prepare(
    'SELECT key, updated_by AS updatedBy, updated_at AS updatedAt FROM app_config',
  ).all<{ key: string; updatedBy: string | null; updatedAt: number }>();
  const meta = new Map(results.map((r) => [r.key, r]));
  return (Object.keys(configSchema.shape) as ConfigKey[]).map((key) => ({
    key,
    value: current[key],
    default: CONFIG_DEFAULTS[key],
    updatedAt: meta.get(key)?.updatedAt ?? null,
    updatedBy: meta.get(key)?.updatedBy ?? null,
  }));
}

export async function updateConfig(
  ctx: Ctx,
  actorId: string,
  key: string,
  value: unknown,
): Promise<unknown> {
  if (!(key in configSchema.shape)) throw new AppError('NOT_FOUND', 'unknown config key');
  return setConfig(ctx.env, key as ConfigKey, value, actorId, ctx.now());
}

const CATALOG: Record<string, { table: string; fields: Record<string, 'int' | 'bool' | 'text'> }> =
  {
    plans: {
      table: 'plans',
      fields: {
        name: 'text',
        price_idr: 'int',
        storage_bytes: 'int',
        compress_quota: 'int',
        max_members: 'int',
        max_file_bytes: 'int',
        show_ads: 'bool',
        active: 'bool',
        sort: 'int',
      },
    },
    addons: {
      table: 'addons',
      fields: { name: 'text', price_idr: 'int', storage_bytes: 'int', active: 'bool', sort: 'int' },
    },
    compress_packs: {
      table: 'compress_packs',
      fields: {
        name: 'text',
        price_idr: 'int',
        credits: 'int',
        ttl_days: 'int',
        active: 'bool',
        sort: 'int',
      },
    },
  };

export async function catalogView(ctx: Ctx) {
  const out: Record<string, unknown[]> = {};
  for (const [name, def] of Object.entries(CATALOG)) {
    out[name] = (
      await ctx.env.DB.prepare(`SELECT * FROM ${def.table} ORDER BY sort, code`).all()
    ).results;
  }
  return out;
}

/** Price/quota changes apply to new purchases and the next renewal; never retroactively. */
export async function updateCatalogItem(
  ctx: Ctx,
  actorId: string,
  kind: string,
  code: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const def = CATALOG[kind];
  if (!def) throw new AppError('NOT_FOUND', 'unknown catalog');
  const sets: string[] = [];
  const binds: unknown[] = [code];
  for (const [k, v] of Object.entries(patch)) {
    const type = def.fields[k];
    if (!type) throw new AppError('VALIDATION', `field ${k} is not editable`);
    if (type === 'int' && (!Number.isInteger(v) || (v as number) < 0))
      throw new AppError('VALIDATION', `${k} must be a non-negative integer`);
    if (type === 'bool' && typeof v !== 'boolean')
      throw new AppError('VALIDATION', `${k} must be a boolean`);
    if (type === 'text' && (typeof v !== 'string' || !v.trim() || v.length > 80))
      throw new AppError('VALIDATION', `${k} must be text`);
    binds.push(type === 'bool' ? (v ? 1 : 0) : v);
    sets.push(`${k} = ?${binds.length}`);
  }
  if (!sets.length) return;
  const prev = await ctx.env.DB.prepare(`SELECT * FROM ${def.table} WHERE code = ?1`)
    .bind(code)
    .first();
  if (!prev) throw new AppError('NOT_FOUND', 'item not found');
  await ctx.env.DB.prepare(`UPDATE ${def.table} SET ${sets.join(', ')} WHERE code = ?1`)
    .bind(...binds)
    .run();
  await audit(ctx, actorId, 'catalog.update', kind, code, { from: prev, patch });
}

// ── Email ──

/**
 * One message through the email adapter this Worker is running, so the operator sees mail arrive
 * (or the relay's refusal, word for word) without waiting for a real notice. `adapter` names the
 * path it took: `mock` means nothing left the Worker (no token, or not `relay`/`cloudflare`).
 */
export async function sendTestEmail(ctx: Ctx, actorId: string, to: string) {
  const adapter = ctx.adapters.email.name;
  try {
    const { id } = await ctx.adapters.email.send({
      to: [to],
      tag: 'test',
      ...noticeEmail({
        title: 'Email uji dari Zeiko Drive',
        paragraphs: [
          'Kalau email ini sampai, Zeiko Drive bisa mengirim email ke pengguna: notifikasi, undangan keluarga, dan berbagi lewat email.',
          `Dikirim lewat: ${adapter}.`,
        ],
      }),
    });
    await audit(ctx, actorId, 'email.test', 'email', to, { adapter, id });
    return { ok: true as const, adapter, id };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await audit(ctx, actorId, 'email.test', 'email', to, { adapter, error });
    return { ok: false as const, adapter, error };
  }
}

// ── Audit ──
export async function auditLog(
  ctx: Ctx,
  f: { action?: string | undefined; targetId?: string | undefined; before?: number | undefined },
) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT a.id, a.actor_id AS actorId, u.email AS actorEmail, a.action, a.target_type AS targetType, a.target_id AS targetId,
            a.meta_json AS meta, a.created_at AS createdAt
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
     WHERE (?1 IS NULL OR a.action LIKE ?1 || '%') AND (?2 IS NULL OR a.target_id = ?2) AND a.created_at < ?3
     ORDER BY a.created_at DESC LIMIT 100`,
  )
    .bind(f.action ?? null, f.targetId ?? null, f.before ?? Number.MAX_SAFE_INTEGER)
    .all();
  return results;
}

// ── Plans given by the operator (relay screen, ADR-036) ──
/**
 * Puts the user's personal pool on `planCode` for `months` from now, free of charge: compensation,
 * a partner, a test account. Their current subscription ends now. No auto-renewal: when it ends the
 * ordinary dunning applies, as for any unpaid period.
 */
export async function grantPlan(
  ctx: Ctx,
  actorId: string,
  userId: string,
  planCode: string,
  months: number,
  reason: string | undefined,
): Promise<void> {
  const r = requireReason(reason);
  if (!Number.isInteger(months) || months < 1 || months > 24)
    throw new AppError('VALIDATION', 'months must be 1-24', { field: 'months' });
  const DB = ctx.env.DB;
  const plan = await DB.prepare('SELECT code, name, price_idr FROM plans WHERE code = ?1')
    .bind(planCode)
    .first<{ code: string; name: string; price_idr: number }>();
  if (!plan) throw new AppError('NOT_FOUND', 'unknown plan', { field: 'planCode' });
  const space = await ensurePersonalSpace(ctx, userId);
  const now = ctx.now();
  const anchor = wibAnchorDay(now);
  let end = now;
  for (let i = 0; i < months; i++) end = addBillingMonth(end, anchor);
  const subId = ulid(now);
  await DB.batch([
    DB.prepare(
      `UPDATE subscriptions SET status = 'cancelled', status_changed_at = ?2, updated_at = ?2
       WHERE pool_id = ?1 AND status IN ('active', 'grace', 'readonly', 'suspended')`,
    ).bind(space.poolId, now),
    DB.prepare(
      `INSERT INTO subscriptions (id, pool_id, payer_user_id, plan_code, status, period_start, period_end, anchor_day,
         auto_renew, cancel_at_period_end, status_changed_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, 0, 1, ?5, ?5, ?5)`,
    ).bind(subId, space.poolId, userId, plan.code, now, end, anchor),
    poolLimitStmt(ctx, space.poolId),
  ]);
  await audit(ctx, actorId, 'plan.grant', 'user', userId, { plan: plan.code, months, reason: r });
}
