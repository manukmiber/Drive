// /api/shares — owner-side management of share links and sending them (SPEC §6).
import { Hono } from 'hono';
import { z } from 'zod';
import { SHARE_CHANNELS } from '../../shared/enums';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { clientIp, rateLimit } from '../middleware/ratelimit';
import { logDeeplinkSend, sendShareEmail } from '../services/share-send';
import {
  createShare,
  listMyShares,
  regenerateShare,
  requireOwnShare,
  revokeShare,
  toShareDto,
  updateShare,
} from '../services/shares';
import type { AppBindings } from '../types';

const hours = z
  .number()
  .int()
  .min(0)
  .max(24 * 365 * 5)
  .nullable();
const password = z.string().min(4).max(128).nullable();

export const shares = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', validate('query', z.object({ nodeId: z.string().max(40).optional() })), async (c) =>
    c.json({
      items: await listMyShares(c.get('ctx'), c.get('user')!.id, c.req.valid('query').nodeId),
    }),
  )
  .post(
    '/',
    rateLimit('RL_SHARE_CREATE', 'share-create'),
    validate(
      'json',
      z.object({
        nodeIds: z.array(z.string().max(40)).min(1).max(100),
        title: z.string().max(200).optional(),
        expiresInHours: hours.optional(),
        maxDownloads: z.number().int().min(1).max(1_000_000).nullable().optional(),
        password: password.optional(),
        showListing: z.boolean().optional(),
      }),
    ),
    async (c) =>
      c.json(
        { share: await createShare(c.get('ctx'), c.get('user')!.id, c.req.valid('json')) },
        201,
      ),
  )
  .get('/:id', async (c) => {
    const ctx = c.get('ctx');
    return c.json({
      share: await toShareDto(
        ctx,
        await requireOwnShare(ctx, c.get('user')!.id, c.req.param('id')),
      ),
    });
  })
  .patch(
    '/:id',
    validate(
      'json',
      z.object({
        title: z.string().max(200).optional(),
        expiresInHours: hours.optional(),
        maxDownloads: z.number().int().min(1).max(1_000_000).nullable().optional(),
        password: password.optional(),
        showListing: z.boolean().optional(),
      }),
    ),
    async (c) =>
      c.json({
        share: await updateShare(
          c.get('ctx'),
          c.get('user')!.id,
          c.req.param('id'),
          c.req.valid('json'),
        ),
      }),
  )
  .delete('/:id', async (c) => {
    await revokeShare(c.get('ctx'), c.get('user')!.id, c.req.param('id'));
    return c.body(null, 204);
  })
  .post('/:id/regenerate', async (c) =>
    c.json({ share: await regenerateShare(c.get('ctx'), c.get('user')!.id, c.req.param('id')) }),
  )
  .post(
    '/:id/sends',
    rateLimit('RL_SHARE_SEND', 'share-send'),
    validate(
      'json',
      z.discriminatedUnion('mode', [
        z.object({
          mode: z.literal('deeplink'),
          channel: z.enum(SHARE_CHANNELS),
          recipient: z.string().max(64).nullable().optional(),
          message: z.string().max(2000).nullable().optional(),
        }),
        z.object({
          mode: z.literal('email'),
          recipients: z.array(z.string().max(254)).min(1).max(20),
          message: z.string().max(2000).nullable().optional(),
          turnstileToken: z.string().max(4096).nullable().optional(),
        }),
      ]),
    ),
    async (c) => {
      const ctx = c.get('ctx');
      const user = c.get('user')!;
      const body = c.req.valid('json');
      const id = c.req.param('id');
      if (body.mode === 'deeplink') return c.json(await logDeeplinkSend(ctx, user.id, id, body));
      return c.json(await sendShareEmail(ctx, user, id, body, clientIp(c.req.raw)));
    },
  );
