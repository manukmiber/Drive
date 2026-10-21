// Atomic quota accounting on storage_pools (SPEC §4, ADR-020).
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';

/** Reserves `bytes` if it fits: one conditional UPDATE, `meta.changes = 0` means full. */
export async function reserveQuota(ctx: Ctx, poolId: string, bytes: number): Promise<boolean> {
  const res = await ctx.env.DB.prepare(
    `UPDATE storage_pools SET reserved_bytes = reserved_bytes + ?2, updated_at = ?3
     WHERE id = ?1 AND used_bytes + reserved_bytes + ?2 <= limit_bytes`,
  )
    .bind(poolId, bytes, ctx.now())
    .run();
  return res.meta.changes === 1;
}

export function releaseQuotaStmt(ctx: Ctx, poolId: string, bytes: number): D1PreparedStatement {
  return ctx.env.DB.prepare(
    `UPDATE storage_pools SET reserved_bytes = MAX(0, reserved_bytes - ?2), updated_at = ?3 WHERE id = ?1`,
  ).bind(poolId, bytes, ctx.now());
}

export async function releaseQuota(ctx: Ctx, poolId: string, bytes: number): Promise<void> {
  await releaseQuotaStmt(ctx, poolId, bytes).run();
}

/** Adds committed usage directly (e.g. "Buat salinan"), only if it fits. */
export async function addUsedIfFits(ctx: Ctx, poolId: string, bytes: number): Promise<boolean> {
  const res = await ctx.env.DB.prepare(
    `UPDATE storage_pools SET used_bytes = used_bytes + ?2, updated_at = ?3
     WHERE id = ?1 AND used_bytes + reserved_bytes + ?2 <= limit_bytes`,
  )
    .bind(poolId, bytes, ctx.now())
    .run();
  return res.meta.changes === 1;
}

export async function quotaFullError(ctx: Ctx, poolId: string, needed: number): Promise<AppError> {
  const pool = await ctx.env.DB.prepare(
    'SELECT limit_bytes, used_bytes, reserved_bytes FROM storage_pools WHERE id = ?1',
  )
    .bind(poolId)
    .first<{ limit_bytes: number; used_bytes: number; reserved_bytes: number }>();
  return new AppError('QUOTA_FULL', 'storage is full', {
    neededBytes: needed,
    limitBytes: pool?.limit_bytes ?? 0,
    usedBytes: pool?.used_bytes ?? 0,
    reservedBytes: pool?.reserved_bytes ?? 0,
  });
}

/**
 * Nightly reconciliation (SPEC §4): recompute used/reserved from nodes and report drift.
 * used = ready file nodes, reserved = uploading/scanning file nodes. Only `used_bytes` is corrected
 * automatically: reservations are taken just before their node row is written, so a reserved drift
 * can be a race and is reported, not "fixed".
 */
export async function reconcilePools(
  ctx: Ctx,
): Promise<Array<{ poolId: string; usedDrift: number; reservedDrift: number }>> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT p.id AS pool_id, p.used_bytes, p.reserved_bytes,
       COALESCE((SELECT SUM(size) FROM nodes n WHERE n.pool_id = p.id AND n.kind = 'file' AND n.status = 'ready'), 0) AS used_actual,
       COALESCE((SELECT SUM(size) FROM nodes n WHERE n.pool_id = p.id AND n.kind = 'file' AND n.status IN ('uploading', 'scanning')), 0) AS reserved_actual
     FROM storage_pools p`,
  ).all<{
    pool_id: string;
    used_bytes: number;
    reserved_bytes: number;
    used_actual: number;
    reserved_actual: number;
  }>();
  const drift: Array<{ poolId: string; usedDrift: number; reservedDrift: number }> = [];
  const fixes: D1PreparedStatement[] = [];
  for (const r of results) {
    const usedDrift = r.used_bytes - r.used_actual;
    const reservedDrift = r.reserved_bytes - r.reserved_actual;
    if (usedDrift !== 0 || reservedDrift !== 0)
      drift.push({ poolId: r.pool_id, usedDrift, reservedDrift });
    if (usedDrift !== 0) {
      fixes.push(
        ctx.env.DB.prepare(
          'UPDATE storage_pools SET used_bytes = ?2, updated_at = ?3 WHERE id = ?1',
        ).bind(r.pool_id, r.used_actual, ctx.now()),
      );
    }
  }
  if (fixes.length) await ctx.env.DB.batch(fixes);
  return drift;
}
