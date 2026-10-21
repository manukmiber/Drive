// Storage pool reads ("storage info" in the diagram).
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db/client';

export interface PoolUsage {
  poolId: string;
  limitBytes: number;
  usedBytes: number;
  reservedBytes: number;
}

export async function getPoolUsage(ctx: Ctx, poolId: string): Promise<PoolUsage> {
  const row = await ctx.db
    .select({
      poolId: schema.storagePools.id,
      limitBytes: schema.storagePools.limitBytes,
      usedBytes: schema.storagePools.usedBytes,
      reservedBytes: schema.storagePools.reservedBytes,
    })
    .from(schema.storagePools)
    .where(eq(schema.storagePools.id, poolId))
    .get();
  if (!row) throw new Error(`pool ${poolId} missing`);
  return row;
}

export interface SubscriptionSummary {
  id: string;
  planCode: string;
  planName: string;
  status: string;
  periodEnd: number;
  showAds: boolean;
  maxFileBytes: number;
}

export async function getActiveSubscription(
  ctx: Ctx,
  poolId: string,
): Promise<SubscriptionSummary | null> {
  const row = await ctx.db
    .select({
      id: schema.subscriptions.id,
      planCode: schema.subscriptions.planCode,
      planName: schema.plans.name,
      status: schema.subscriptions.status,
      periodEnd: schema.subscriptions.periodEnd,
      showAds: schema.plans.showAds,
      maxFileBytes: schema.plans.maxFileBytes,
    })
    .from(schema.subscriptions)
    .innerJoin(schema.plans, eq(schema.plans.code, schema.subscriptions.planCode))
    .where(
      and(
        eq(schema.subscriptions.poolId, poolId),
        inArray(schema.subscriptions.status, ['active', 'grace', 'readonly', 'suspended']),
      ),
    )
    .orderBy(desc(schema.subscriptions.createdAt))
    .get();
  return row ?? null;
}
