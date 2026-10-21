// Demo data for local dev (never runs outside APP_ENV=dev). Idempotent.
import { eq } from 'drizzle-orm';
import { GIB } from '../src/shared/constants';
import { ulid } from '../src/worker/lib/ids';
import { createCtx } from '../src/worker/context';
import { schema } from '../src/worker/db/client';
import type { Env } from '../src/worker/env';
import { ensurePersonalSpace } from '../src/worker/services/accounts';
import { addBillingMonth } from '../src/shared/time';

export const DEMO_USERS = [
  {
    id: '01JD0000000000000000DEM0A1',
    email: 'demo@zeiko.local',
    name: 'Demo Zeiko',
    role: 'user',
    plan: 'plus',
  },
  {
    id: '01JD0000000000000000ADM1N1',
    email: 'admin@zeiko.local',
    name: 'Admin Zeiko',
    role: 'admin',
    plan: 'max',
  },
  {
    id: '01JD0000000000000000BAR001',
    email: 'baru@zeiko.local',
    name: 'Pengguna Baru',
    role: 'user',
    plan: null,
  },
] as const;

export async function seedDemo(env: Env): Promise<void> {
  if (env.APP_ENV !== 'dev') return;
  const ctx = createCtx(env);
  const { db } = ctx;
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, DEMO_USERS[0].id))
    .get();
  if (existing) return;
  const now = ctx.now();
  for (const u of DEMO_USERS) {
    await db.insert(schema.users).values({
      id: u.id,
      email: u.email,
      emailVerified: true,
      name: u.name,
      role: u.role,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const space = await ensurePersonalSpace(ctx, u.id);
    await db.insert(schema.wallets).values({ userId: u.id, balanceIdr: 50_000, updatedAt: now });
    if (!u.plan) continue;
    const plan = await db.select().from(schema.plans).where(eq(schema.plans.code, u.plan)).get();
    if (!plan) continue;
    const anchorDay = new Date(now + 7 * 3600_000).getUTCDate();
    await db.insert(schema.subscriptions).values({
      id: ulid(now),
      poolId: space.poolId,
      payerUserId: u.id,
      planCode: plan.code,
      status: 'active',
      periodStart: now,
      periodEnd: addBillingMonth(now, anchorDay),
      anchorDay,
      statusChangedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(schema.storagePools)
      .set({ limitBytes: plan.storageBytes, updatedAt: now })
      .where(eq(schema.storagePools.id, space.poolId));
  }
  console.log(
    `[seed] demo users: ${DEMO_USERS.map((u) => u.email).join(', ')} (Plus = ${120} GB = ${120 * GIB} B)`,
  );
}
