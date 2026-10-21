// /api/billing — Saldo, plans, add-ons, compress packs, invoices (SPEC §12).
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import {
  billingSummary,
  buyAddon,
  buyCompressPack,
  cancelAddon,
  choosePlan,
  createTopup,
  getInvoice,
  listInvoices,
  listLedger,
  setAutoRenew,
} from '../services/billing';
import type { AppBindings } from '../types';

const code = z.string().min(1).max(40);
const then = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), code }),
  z.object({ kind: z.literal('addon'), code }),
  z.object({ kind: z.literal('compress'), code }),
]);

export const billing = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json(await billingSummary(c.get('ctx'), c.get('user')!.id)))
  .get('/ledger', async (c) => c.json({ items: await listLedger(c.get('ctx'), c.get('user')!.id) }))
  .get('/invoices', async (c) =>
    c.json({ items: await listInvoices(c.get('ctx'), c.get('user')!.id) }),
  )
  .get('/invoices/:id', async (c) =>
    c.json(await getInvoice(c.get('ctx'), c.get('user')!.id, c.req.param('id'))),
  )
  .post(
    '/topups',
    rateLimit('RL_SHARE_CREATE', 'topup'),
    validate(
      'json',
      z.object({ amountIdr: z.number().int().positive(), method: code, then: then.optional() }),
    ),
    async (c) => c.json(await createTopup(c.get('ctx'), c.get('user')!, c.req.valid('json')), 201),
  )
  .post('/plan', validate('json', z.object({ planCode: code })), async (c) =>
    c.json(await choosePlan(c.get('ctx'), c.get('user')!.id, c.req.valid('json').planCode)),
  )
  .post(
    '/plan/renewal',
    validate('json', z.object({ cancelAtPeriodEnd: z.boolean() })),
    async (c) => {
      await setAutoRenew(c.get('ctx'), c.get('user')!.id, c.req.valid('json').cancelAtPeriodEnd);
      return c.body(null, 204);
    },
  )
  .post('/addons', validate('json', z.object({ addonCode: code })), async (c) =>
    c.json(await buyAddon(c.get('ctx'), c.get('user')!.id, c.req.valid('json').addonCode), 201),
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
  )
  .post('/compress-packs', validate('json', z.object({ packCode: code })), async (c) =>
    c.json(
      await buyCompressPack(c.get('ctx'), c.get('user')!.id, c.req.valid('json').packCode),
      201,
    ),
  );
