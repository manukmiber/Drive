// /api/billing — the plan, add-ons, compress packs, the Zeiko S3 plan and paying for them (SPEC §12,
// ADR-041, ADR-047).
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import { billingSummary, cancelAddon, checkout, paymentStatus } from '../services/billing';
import type { AppBindings } from '../types';

const code = z.string().min(1).max(40);
const item = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), code }),
  z.object({ kind: z.literal('addon'), code }),
  z.object({ kind: z.literal('compress'), code }),
  z.object({ kind: z.literal('renew') }),
  z.object({
    kind: z.literal('s3_plan'),
    gb: z.number().int().positive(),
    replicas: z.union([z.literal(1), z.literal(3)]),
  }),
  z.object({ kind: z.literal('s3_renew') }),
]);

export const billing = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json(await billingSummary(c.get('ctx'), c.get('user')!.id)))
  .get('/payments/:id', async (c) =>
    c.json(await paymentStatus(c.get('ctx'), c.get('user')!.id, c.req.param('id').slice(0, 40))),
  )
  .post(
    '/checkout',
    rateLimit('RL_SHARE_CREATE', 'checkout'),
    validate('json', z.object({ item })),
    async (c) => {
      const r = await checkout(c.get('ctx'), c.get('user')!, c.req.valid('json').item);
      return c.json(r, r.status === 'payment' ? 201 : 200);
    },
  )
  .patch(
    '/addons/:id',
    validate('json', z.object({ cancelAtPeriodEnd: z.boolean() })),
    async (c) => {
      await cancelAddon(
        c.get('ctx'),
        c.get('user')!.id,
        c.req.param('id'),
        c.req.valid('json').cancelAtPeriodEnd,
      );
      return c.body(null, 204);
    },
  );
