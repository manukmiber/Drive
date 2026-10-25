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
  peopleByZeikoId,
  searchUsers,
  sendTestEmail,
  setBonusQuota,
  setUserSuspended,
  updateCatalogItem,
  updateConfig,
} from '../services/admin';
import { storageReport } from '../services/storage-report';
import {
  accountView,
  attachIndex,
  blockBucket,
  enableAccount,
  findUser,
  listAccounts,
  updateAccount,
} from '../services/s3';
import { indexBindings } from '../services/s3-index';
import { s3PlanView } from '../services/s3-billing';
import { s3UrlView } from '../services/s3-urls';
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
  // R2 against what Drive sold (ADR-037): real usage, people × plan, Class A/B and the margin.
  .get('/storage', async (c) => c.json(await storageReport(c.get('ctx'))))
  .get('/catalog', async (c) => c.json(await catalogView(c.get('ctx'))))
  .patch('/catalog/:kind/:code', validate('json', z.record(z.string(), z.unknown())), async (c) => {
    const { reason: why, ...patch } = c.req.valid('json');
    if (typeof why !== 'string' || why.trim().length < 5)
      throw new AppError('VALIDATION', 'a reason is required', { field: 'reason' });
    await updateCatalogItem(c.get('ctx'), OPS_ACTOR, c.req.param('kind'), c.req.param('code'), {
      ...patch,
    });
    return c.body(null, 204);
  })
  .get('/config', async (c) => c.json({ items: await configView(c.get('ctx')) }))
  .put('/config/:key', validate('json', z.object({ value: z.unknown(), reason })), async (c) => {
    const b = c.req.valid('json');
    if ((b.reason ?? '').trim().length < 5)
      throw new AppError('VALIDATION', 'a reason is required', { field: 'reason' });
    const value = await updateConfig(c.get('ctx'), OPS_ACTOR, c.req.param('key'), b.value);
    return c.json({ value });
  })
  .get('/users', validate('query', z.object({ q: z.string().max(200).default('') })), async (c) =>
    c.json({ items: await searchUsers(c.get('ctx'), c.req.valid('query').q) }),
  )
  // The relay's one People list (Zeiko Accounts, ADR-040) asks for Drive's side of a page of people.
  .post(
    '/people',
    validate('json', z.object({ zeikoIds: z.array(z.string().max(128)).max(500) })),
    async (c) =>
      c.json({ items: await peopleByZeikoId(c.get('ctx'), c.req.valid('json').zeikoIds) }),
  )
  .post(
    '/users/:id/balance',
    validate('json', z.object({ deltaIdr: z.number().int(), reason })),
    async (c) => {
      const b = c.req.valid('json');
      const balanceIdr = await adjustBalance(
        c.get('ctx'),
        OPS_ACTOR,
        c.req.param('id'),
        b.deltaIdr,
        b.reason,
      );
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
    validate(
      'json',
      z.object({ planCode: z.string().min(1).max(40), months: z.number().int(), reason }),
    ),
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
  // A test message through the live email adapter: 200 either way, `ok` and the relay's own words.
  .post(
    '/test-email',
    validate('json', z.object({ to: z.string().trim().email().max(254) })),
    async (c) => c.json(await sendTestEmail(c.get('ctx'), OPS_ACTOR, c.req.valid('json').to)),
  )
  // Zeiko S3 (ADR-044): the relay's "add user" button and what goes with it.
  .get('/s3/accounts', async (c) =>
    c.json({ items: await listAccounts(c.get('ctx')), indexBindings: indexBindings(c.env) }),
  )
  .post(
    '/s3/accounts',
    validate(
      'json',
      z
        .object({
          userId: z.string().max(40).optional(),
          zeikoId: z.string().max(128).optional(),
          email: z.string().trim().email().max(254).optional(),
          limitBytes: z.number().int().nonnegative(),
          reason,
        })
        .refine((b) => b.userId || b.zeikoId || b.email, { message: 'userId, zeikoId or email' }),
    ),
    async (c) => {
      const b = c.req.valid('json');
      const ctx = c.get('ctx');
      const userId = await findUser(ctx, b);
      return c.json({
        account: await enableAccount(ctx, OPS_ACTOR, userId, b.limitBytes, b.reason),
      });
    },
  )
  .get('/s3/accounts/:userId', async (c) => {
    const ctx = c.get('ctx');
    const userId = c.req.param('userId');
    const account = await accountView(ctx, userId);
    return c.json({
      account,
      plan: await s3PlanView(ctx, userId),
      url: await s3UrlView(ctx, userId),
    });
  })
  .patch(
    '/s3/accounts/:userId',
    validate(
      'json',
      z.object({
        limitBytes: z.number().int().nonnegative().optional(),
        suspended: z.boolean().optional(),
        reason,
      }),
    ),
    async (c) => {
      const { reason: why, ...patch } = c.req.valid('json');
      return c.json({
        account: await updateAccount(c.get('ctx'), OPS_ACTOR, c.req.param('userId'), patch, why),
      });
    },
  )
  // An index database of the account's own (the diagram's "1 user, 1 D1"), already bound as S3_DB_*.
  .put(
    '/s3/accounts/:userId/index',
    validate('json', z.object({ binding: z.string().max(60), reason })),
    async (c) => {
      const b = c.req.valid('json');
      return c.json({
        account: await attachIndex(
          c.get('ctx'),
          OPS_ACTOR,
          c.req.param('userId'),
          b.binding,
          b.reason,
        ),
      });
    },
  )
  .post(
    '/s3/buckets/:name/block',
    validate('json', z.object({ blocked: z.boolean(), reason })),
    async (c) => {
      const b = c.req.valid('json');
      await blockBucket(c.get('ctx'), OPS_ACTOR, c.req.param('name'), b.blocked, b.reason);
      return c.body(null, 204);
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
