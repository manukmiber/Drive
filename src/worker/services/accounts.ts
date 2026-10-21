// Account bootstrap: every user gets a personal storage pool and a personal root folder
// ("1 folder = 1 user" in the diagram; the R2 prefix is u/{userId}/).
import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db/client';
import { ulid } from '../lib/ids';
import { nameKey } from '../lib/names';

export const PERSONAL_ROOT_NAME = 'Drive Saya';
export const FAMILY_ROOT_NAME = 'Drive Keluarga';

export interface UserSpace {
  poolId: string;
  personalRootId: string;
  familyId: string | null;
  familyRootId: string | null;
}

/** Idempotent: safe to call on every sign-in. */
export async function ensurePersonalSpace(ctx: Ctx, userId: string): Promise<UserSpace> {
  const { db } = ctx;
  const now = ctx.now();
  const poolId = ulid(now);
  await db
    .insert(schema.storagePools)
    .values({ id: poolId, ownerType: 'user', ownerId: userId, updatedAt: now })
    .onConflictDoNothing();
  const personalPool = await db
    .select({ id: schema.storagePools.id })
    .from(schema.storagePools)
    .where(and(eq(schema.storagePools.ownerType, 'user'), eq(schema.storagePools.ownerId, userId)))
    .get();
  if (!personalPool) throw new Error('personal pool missing after insert');

  const membership = await db
    .select({ familyId: schema.familyMembers.familyId, poolId: schema.families.poolId })
    .from(schema.familyMembers)
    .innerJoin(schema.families, eq(schema.families.id, schema.familyMembers.familyId))
    .where(eq(schema.familyMembers.userId, userId))
    .get();
  const activePoolId = membership?.poolId ?? personalPool.id;

  await db
    .insert(schema.nodes)
    .values({
      id: ulid(now),
      poolId: activePoolId,
      space: 'personal',
      ownerId: userId,
      createdBy: userId,
      parentId: null,
      kind: 'folder',
      name: PERSONAL_ROOT_NAME,
      nameKey: nameKey(PERSONAL_ROOT_NAME),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const root = await db
    .select({ id: schema.nodes.id })
    .from(schema.nodes)
    .where(
      and(
        eq(schema.nodes.ownerId, userId),
        eq(schema.nodes.space, 'personal'),
        isNull(schema.nodes.parentId),
      ),
    )
    .get();
  if (!root) throw new Error('personal root missing after insert');

  let familyRootId: string | null = null;
  if (membership) {
    const fr = await db
      .select({ id: schema.nodes.id })
      .from(schema.nodes)
      .where(
        and(
          eq(schema.nodes.familyId, membership.familyId),
          eq(schema.nodes.space, 'family'),
          isNull(schema.nodes.parentId),
        ),
      )
      .get();
    familyRootId = fr?.id ?? null;
  }

  return {
    poolId: activePoolId,
    personalRootId: root.id,
    familyId: membership?.familyId ?? null,
    familyRootId,
  };
}
