// /api/family — paket keluarga (SPEC §9).
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import {
  acceptInvite,
  createInvite,
  dissolveFamily,
  emailInvite,
  familyOverview,
  previewInvite,
  removeMember,
  renameFamily,
  revokeInvite,
  setMemberCap,
} from '../services/family';
import type { AppBindings } from '../types';

export const family = new Hono<AppBindings>()
  // Invite preview works signed-out too (the page then asks to sign in).
  .get('/invites/:token', async (c) =>
    c.json(await previewInvite(c.get('ctx'), c.req.param('token'), c.get('user')?.id ?? null)),
  )
  .use('*', requireUser)
  .get('/', async (c) => c.json(await familyOverview(c.get('ctx'), c.get('user')!.id)))
  .patch('/', validate('json', z.object({ name: z.string().min(1).max(60) })), async (c) => {
    await renameFamily(c.get('ctx'), c.get('user')!.id, c.req.valid('json').name);
    return c.body(null, 204);
  })
  .post(
    '/invites',
    rateLimit('RL_SHARE_CREATE', 'family-invite'),
    validate(
      'json',
      z.object({
        channel: z.string().max(20).default('link'),
        email: z.string().max(254).optional(),
      }),
    ),
    async (c) => {
      const b = c.req.valid('json');
      if (b.email) return c.json(await emailInvite(c.get('ctx'), c.get('user')!.id, b.email), 201);
      return c.json(await createInvite(c.get('ctx'), c.get('user')!.id, b.channel), 201);
    },
  )
  .delete('/invites/:id', async (c) => {
    await revokeInvite(c.get('ctx'), c.get('user')!.id, c.req.param('id'));
    return c.body(null, 204);
  })
  .post(
    '/invites/:token/accept',
    validate('json', z.object({ convertPlan: z.boolean().default(false) })),
    async (c) =>
      c.json(
        await acceptInvite(
          c.get('ctx'),
          c.get('user')!.id,
          c.req.param('token'),
          c.req.valid('json').convertPlan,
        ),
      ),
  )
  .post('/leave', async (c) => {
    await removeMember(c.get('ctx'), c.get('user')!.id, c.get('user')!.id);
    return c.body(null, 204);
  })
  .delete('/members/:id', async (c) => {
    await removeMember(c.get('ctx'), c.get('user')!.id, c.req.param('id'));
    return c.body(null, 204);
  })
  .patch(
    '/members/:id',
    validate('json', z.object({ capBytes: z.number().int().positive().nullable() })),
    async (c) => {
      await setMemberCap(
        c.get('ctx'),
        c.get('user')!.id,
        c.req.param('id'),
        c.req.valid('json').capBytes,
      );
      return c.body(null, 204);
    },
  )
  .post('/dissolve', async (c) => c.json(await dissolveFamily(c.get('ctx'), c.get('user')!.id)));
