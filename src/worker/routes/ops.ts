// The relay's Zeiko Drive screen (ADR-036): profit, the catalog, business numbers, people and
// payments, server to server with `ZEIKO_OPS_TOKEN` as a bearer. Same services and the same
// rules as /api/admin (a reason on every change, an audit row, no way to a user's files); the
// actor is the relay's operator. Without the token every path is a plain 404.
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { timingSafeEqual } from '../lib/crypto';
import { validate } from '../lib/validate';
import {
  adjustBalance,
  auditLog,
  catalogView,
  configView,
  dashboard,
  grantPlan,
  searchUsers,
  setBonusQuota,
  setUserSuspended,
  updateCatalogItem,
  updateConfig,
} from '../services/admin';
import type { AppBindings } from '../types';

/** Who the audit log says made an operator's change. */
export const OPS_ACTOR = 'relay-operator';
/** Shorter than this, the token is treated as unset. */
const MIN_TOKEN = 32;

const opsGate: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = c.env.ZEIKO_OPS_TOKEN ?? '';
  const auth = c.req.header('authorization') ?? '';
  const offered = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token.length < MIN_TOKEN || !timingSafeEqual(offered, token)) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
  }
  c.header('cache-control', 'no-store');
  await next();
};

const reason = z.string().max(500).optional();

export const ops = new Hono<AppBindings>()
  .use('*', opsGate)
  .get(
    '/overview',
    validate('query', z.object({ days: z.coerce.number().int().min(1).max(365).default(30) })),
    async (c) => c.json(await dashboard(c.get('ctx'), c.req.valid('query').days)),
  )
  .get('/catalog', async (c) => c.json(await catalogView(c.get('ctx'))))
  .patch(
    '/catalog/:kind/:code',
    validate('json', z.record(z.string(), z.unknown())),
    async (c) => {
      const { reason: why, ...patch } = c.req.valid('json');
      if (typeof why !== 'string' || why.trim().length < 5)
        throw new AppError('VALIDATION', 'a reason is required', { field: 'reason' });
      await updateCatalogItem(c.get('ctx'), OPS_ACTOR, c.req.param('kind'), c.req.param('code'), {
        ...patch,
      });
      return c.body(null, 204);
    },
  )
  .get('/config', async (c) => c.json({ items: await configView(c.get('ctx')) }))
  .put(
    '/config/:key',
    validate('json', z.object({ value: z.unknown(), reason })),
    async (c) => {
      const b = c.req.valid('json');
      if ((b.reason ?? '').trim().length < 5)
        throw new AppError('VALIDATION', 'a reason is required', { field: 'reason' });
      const value = await updateConfig(c.get('ctx'), OPS_ACTOR, c.req.param('key'), b.value);
      return c.json({ value });
    },
  )
  .get('/users', validate('query', z.object({ q: z.string().max(200).default('') })), async (c) =>
    c.json({ items: await searchUsers(c.get('ctx'), c.req.valid('query').q) }),
  )
  .post(
    '/users/:id/balance',
    validate('json', z.object({ deltaIdr: z.number().int(), reason })),
    async (c) => {
      const b = c.req.valid('json');
      const balanceIdr = await adjustBalance(c.get('ctx'), OPS_ACTOR, c.req.param('id'), b.deltaIdr, b.reason);
      return c.json({ balanceIdr });
    },
  )
  .post(
    '/users/:id/bonus',
    validate('json', z.object({ bonusBytes: z.number().int().nonnegative(), reason })),
    async (c) => {
      const b = c.req.valid('json');
      await setBonusQuota(c.get('ctx'), OPS_ACTOR, c.req.param('id'), b.bonusBytes, b.reason);
      return c.body(null, 204);
    },
  )
  .post(
    '/users/:id/suspend',
    validate('json', z.object({ suspended: z.boolean(), reason })),
    async (c) => {
      const b = c.req.valid('json');
      await setUserSuspended(c.get('ctx'), OPS_ACTOR, c.req.param('id'), b.suspended, b.reason);
      return c.body(null, 204);
    },
  )
  .post(
    '/users/:id/plan',
    validate('json', z.object({ planCode: z.string().min(1).max(40), months: z.number().int(), reason })),
    async (c) => {
      const b = c.req.valid('json');
      await grantPlan(c.get('ctx'), OPS_ACTOR, c.req.param('id'), b.planCode, b.months, b.reason);
      return c.body(null, 204);
    },
  )
  .get(
    '/payments',
    validate('query', z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) })),
    async (c) => {
      const { results } = await c.env.DB.prepare(
        `SELECT p.id, p.user_id AS userId, u.email, p.provider, p.provider_ref AS providerRef, p.method,
                p.amount_idr AS amountIdr, p.fee_idr AS feeIdr, p.status, p.purpose, p.created_at AS createdAt,
                p.paid_at AS paidAt
         FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT ?1`,
      )
        .bind(c.req.valid('query').limit)
        .all();
      return c.json({ items: results });
    },
  )
  .get(
    '/audit',
    validate(
      'query',
      z.object({
        action: z.string().max(60).optional(),
        targetId: z.string().max(80).optional(),
        before: z.coerce.number().int().optional(),
      }),
    ),
    async (c) => c.json({ items: await auditLog(c.get('ctx'), c.req.valid('query')) }),
  );
