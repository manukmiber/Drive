import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { contentLength } from '../lib/http';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import {
  abortUpload,
  completeUpload,
  initUpload,
  simpleUpload,
  uploadPart,
  uploadStatus,
} from '../services/uploads';
import type { AppBindings } from '../types';

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const onConflict = z.enum(['error', 'rename', 'replace']).optional();

const initBody = z.object({
  parentId: id,
  name: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
  mime: z.string().max(255).nullish(),
  lastModified: z.number().int().nonnegative().nullish(),
  onConflict,
});

const simpleQuery = z.object({
  parentId: id,
  name: z.string().min(1).max(1024),
  size: z.coerce.number().int().nonnegative(),
  mime: z.string().max(255).optional(),
  lastModified: z.coerce.number().int().nonnegative().optional(),
  onConflict,
});

export const uploads = new Hono<AppBindings>()
  .use('*', requireUser)
  .post('/', rateLimit('RL_UPLOAD', 'upload-init'), validate('json', initBody), async (c) => {
    const res = await initUpload(c.get('ctx'), c.get('user')!.id, c.req.valid('json'));
    return c.json(res, 201);
  })
  .put(
    '/simple',
    rateLimit('RL_UPLOAD', 'upload-simple'),
    validate('query', simpleQuery),
    async (c) => {
      const node = await simpleUpload(
        c.get('ctx'),
        c.get('user')!.id,
        c.req.valid('query'),
        contentLength(c.req.header('content-length')),
        c.req.raw.body,
      );
      return c.json({ node }, 201);
    },
  )
  .put('/:id/parts/:n', async (c) => {
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n)) throw new AppError('VALIDATION', 'invalid part number');
    const res = await uploadPart(
      c.get('ctx'),
      c.get('user')!.id,
      c.req.param('id'),
      n,
      contentLength(c.req.header('content-length')),
      c.req.raw.body,
    );
    return c.json(res);
  })
  .get('/:id', async (c) =>
    c.json(await uploadStatus(c.get('ctx'), c.get('user')!.id, c.req.param('id'))),
  )
  .post('/:id/complete', async (c) => {
    const node = await completeUpload(c.get('ctx'), c.get('user')!.id, c.req.param('id'));
    return c.json({ node });
  })
  .delete('/:id', async (c) => {
    await abortUpload(c.get('ctx'), c.get('user')!.id, c.req.param('id'));
    return c.body(null, 204);
  });
