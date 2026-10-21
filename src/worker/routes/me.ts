import { count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { schema } from '../db/client';
import { validate } from '../lib/validate';
import { ensureCsrfCookie, requireUser } from '../middleware/auth';
import { ensurePersonalSpace } from '../services/accounts';
import { cancelDeletion, exportData, requestDeletion } from '../services/account';
import { getActiveSubscription, getPoolUsage } from '../services/storage';
import type { AppBindings } from '../types';

const profilePatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});

export const me = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => {
    const ctx = c.get('ctx');
    const user = c.get('user')!;
    const csrfToken = ensureCsrfCookie(c);
    const [profile, space, passkeys] = await Promise.all([
      ctx.db
        .select({
          image: schema.users.image,
          adCityCode: schema.users.adCityCode,
          deleteRequestedAt: schema.users.deleteRequestedAt,
        })
        .from(schema.users)
        .where(eq(schema.users.id, user.id))
        .get(),
      ensurePersonalSpace(ctx, user.id),
      ctx.db
        .select({ n: count() })
        .from(schema.passkeys)
        .where(eq(schema.passkeys.userId, user.id))
        .get(),
    ]);
    const [storage, subscription] = await Promise.all([
      getPoolUsage(ctx, space.poolId),
      getActiveSubscription(ctx, space.poolId),
    ]);
    return c.json({
      user: { ...user, image: profile?.image ?? null, adCityCode: profile?.adCityCode ?? null },
      deleteRequestedAt: profile?.deleteRequestedAt ?? null,
      hasPasskey: (passkeys?.n ?? 0) > 0,
      space,
      storage,
      subscription,
      csrfToken,
    });
  })
  .patch('/', validate('json', profilePatch), async (c) => {
    const ctx = c.get('ctx');
    const user = c.get('user')!;
    const body = c.req.valid('json');
    if (body.name !== undefined) {
      await ctx.db
        .update(schema.users)
        .set({ name: body.name, updatedAt: new Date(ctx.now()) })
        .where(eq(schema.users.id, user.id));
    }
    return c.json({ ok: true });
  })
  .get('/export', async (c) => {
    const data = await exportData(c.get('ctx'), c.get('user')!.id);
    c.header('Content-Disposition', 'attachment; filename="zeiko-data-saya.json"');
    return c.json(data);
  })
  .post('/delete', validate('json', z.object({ confirmEmail: z.string().max(254) })), async (c) =>
    c.json(await requestDeletion(c.get('ctx'), c.get('user')!, c.req.valid('json').confirmEmail)),
  )
  .delete('/delete', async (c) => {
    await cancelDeletion(c.get('ctx'), c.get('user')!.id);
    return c.body(null, 204);
  });
