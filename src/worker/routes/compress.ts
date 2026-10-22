// /api/compress — media compression jobs (SPEC §11).
import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { contentLength } from '../lib/http';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import {
  completeStandalone,
  createCompressBatch,
  listJobs,
  standaloneResult,
  startStandalone,
  uploadStandalonePart,
} from '../services/compress';
import type { AppBindings } from '../types';

const quality = z.enum(['hemat', 'seimbang', 'tinggi']).default('seimbang');
const media = z.object({
  image: z
    .object({
      format: z.enum(['avif', 'webp', 'jpeg']).default('webp'),
      quality,
      maxWidth: z.number().int().min(16).max(12_000).optional(),
    })
    .default({ format: 'webp', quality: 'seimbang' }),
  video: z
    .object({ preset: z.enum(['1080p', '720p', '480p']).default('720p'), quality })
    .default({ preset: '720p', quality: 'seimbang' }),
});

export const compress = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json(await listJobs(c.get('ctx'), c.get('user')!.id)))
  .post(
    '/',
    validate(
      'json',
      media.extend({
        nodeIds: z.array(z.string().max(40)).min(1).max(500),
        save: z.enum(['copy', 'replace']).default('copy'),
      }),
    ),
    async (c) => {
      const { nodeIds, ...o } = c.req.valid('json');
      return c.json(await createCompressBatch(c.get('ctx'), c.get('user')!.id, nodeIds, o), 201);
    },
  )
  .post(
    '/standalone',
    validate(
      'json',
      media.extend({
        name: z.string().min(1).max(255),
        size: z.number().int().positive(),
        mime: z.string().max(255).nullable().default(null),
      }),
    ),
    async (c) => {
      const { name, size, mime, ...options } = c.req.valid('json');
      return c.json(
        await startStandalone(c.get('ctx'), c.get('user')!.id, { name, size, mime, options }),
        201,
      );
    },
  )
  .put('/standalone/:id/parts/:n', async (c) => {
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n)) throw new AppError('VALIDATION', 'invalid part number');
    return c.json(
      await uploadStandalonePart(
        c.get('ctx'),
        c.get('user')!.id,
        c.req.param('id'),
        n,
        contentLength(c.req.header('content-length')),
        c.req.raw.body,
      ),
    );
  })
  .post(
    '/standalone/:id/complete',
    validate(
      'json',
      z.object({
        parts: z
          .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().max(200) }))
          .min(1)
          .max(10_000),
      }),
    ),
    async (c) =>
      c.json(
        await completeStandalone(
          c.get('ctx'),
          c.get('user')!.id,
          c.req.param('id'),
          c.req.valid('json').parts,
        ),
      ),
  )
  .get('/standalone/:id/result', (c) =>
    standaloneResult(c.get('ctx'), c.get('user')!.id, c.req.param('id')),
  );
