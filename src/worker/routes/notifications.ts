// /api/notifications — the bell (in-app list) and per-channel preferences (SPEC §13.2).
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { getPrefs, listNotifications, markRead, setPref } from '../services/notify';
import type { AppBindings } from '../types';

export const notifications = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json(await listNotifications(c.get('ctx'), c.get('user')!.id)))
  .post(
    '/read',
    validate(
      'json',
      z.object({ ids: z.union([z.array(z.string().max(40)).max(100), z.literal('all')]) }),
    ),
    async (c) => {
      await markRead(c.get('ctx'), c.get('user')!.id, c.req.valid('json').ids);
      return c.body(null, 204);
    },
  )
  .get('/prefs', async (c) => c.json({ items: await getPrefs(c.get('ctx'), c.get('user')!.id) }))
  .put(
    '/prefs',
    validate(
      'json',
      z.object({
        type: z.string().max(40),
        channel: z.enum(['email', 'telegram']),
        enabled: z.boolean(),
      }),
    ),
    async (c) => {
      const b = c.req.valid('json');
      await setPref(c.get('ctx'), c.get('user')!.id, b.type, b.channel, b.enabled);
      return c.body(null, 204);
    },
  );
