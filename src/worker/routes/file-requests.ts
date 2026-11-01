// D3 (ADR-086): file request links. The owner's side under /api/file-requests; the uploader's,
// without an account, under /api/public/requests/{r64}/{s32}.
import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { contentLength } from '../lib/http';
import { verifyTurnstile } from '../lib/turnstile';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { clientIp, rateLimit } from '../middleware/ratelimit';
import {
  cancelDrop,
  createRequest,
  dropPart,
  finishDrop,
  listRequests,
  openDrops,
  publicRequest,
  revokeRequest,
  startDrop,
} from '../services/file-requests';
import type { AppBindings } from '../types';
import { SHARE_PASSWORD_MIN } from '../../shared/constants';

const nodeId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

export const fileRequests = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', validate('query', z.object({ folderId: nodeId.optional() })), async (c) =>
    c.json({
      items: await listRequests(c.get('ctx'), c.get('user')!.id, c.req.valid('query').folderId),
    }),
  )
  .post(
    '/',
    rateLimit('RL_SHARE_CREATE', 'file-request'),
    validate(
      'json',
      z.object({
        folderId: nodeId,
        title: z.string().max(200),
        message: z.string().max(1000).nullish(),
        deadlineAt: z.number().int().nullish(),
        maxFiles: z.number().int().min(1).max(10_000).nullish(),
        maxFileBytes: z.number().int().min(1).nullish(),
        requireName: z.boolean().optional(),
        password: z.string().min(SHARE_PASSWORD_MIN).max(200).nullish(),
      }),
    ),
    async (c) =>
      c.json(
        { request: await createRequest(c.get('ctx'), c.get('user')!.id, c.req.valid('json')) },
        201,
      ),
  )
  .delete('/:id', async (c) => {
    await revokeRequest(c.get('ctx'), c.get('user')!.id, c.req.param('id'));
    return c.body(null, 204);
  });

const TOKEN = 'x-drop-token';

export const publicRequests = new Hono<AppBindings>()
  .get('/requests/:id/:sig', async (c) =>
    c.json(await publicRequest(c.get('ctx'), c.req.param('id'), c.req.param('sig'))),
  )
  .post(
    '/requests/:id/:sig/pass',
    rateLimit('RL_SHARE_SEND', 'request-pass'),
    validate(
      'json',
      z.object({
        password: z.string().max(200).nullish(),
        turnstileToken: z.string().max(4096).nullish(),
      }),
    ),
    async (c) => {
      const { turnstileToken, password } = c.req.valid('json');
      const ctx = c.get('ctx');
      // People without an account prove they're human once per visit (ADR-086).
      if (
        ctx.env.TURNSTILE_SECRET_KEY &&
        !(await verifyTurnstile(ctx, turnstileToken, clientIp(c.req.raw)))
      )
        throw new AppError('FORBIDDEN', 'captcha failed', { reason: 'TURNSTILE' });
      return c.json(await openDrops(ctx, c.req.param('id'), c.req.param('sig'), password));
    },
  )
  .post(
    '/requests/:id/:sig/uploads',
    rateLimit('RL_UPLOAD', 'request-drop'),
    validate(
      'json',
      z.object({
        name: z.string().min(1).max(1024),
        size: z.number().int().nonnegative(),
        mime: z.string().max(255).nullish(),
        lastModified: z.number().int().nonnegative().nullish(),
        uploaderName: z.string().max(100).nullish(),
        pass: z.string().max(200),
      }),
    ),
    async (c) =>
      c.json(
        await startDrop(
          c.get('ctx'),
          c.req.param('id'),
          c.req.param('sig'),
          c.req.valid('json'),
          clientIp(c.req.raw),
        ),
        201,
      ),
  )
  .put('/requests/:id/:sig/uploads/:uid/parts/:n', async (c) => {
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n)) throw new AppError('VALIDATION', 'invalid part number');
    return c.json(
      await dropPart(
        c.get('ctx'),
        c.req.param('id'),
        c.req.param('sig'),
        c.req.param('uid'),
        c.req.header(TOKEN),
        n,
        contentLength(c.req.header('content-length')),
        c.req.raw.body,
      ),
    );
  })
  .post('/requests/:id/:sig/uploads/:uid/complete', async (c) =>
    c.json(
      await finishDrop(
        c.get('ctx'),
        c.req.param('id'),
        c.req.param('sig'),
        c.req.param('uid'),
        c.req.header(TOKEN),
      ),
    ),
  )
  .delete('/requests/:id/:sig/uploads/:uid', async (c) => {
    await cancelDrop(
      c.get('ctx'),
      c.req.param('id'),
      c.req.param('sig'),
      c.req.param('uid'),
      c.req.header(TOKEN),
    );
    return c.body(null, 204);
  });
