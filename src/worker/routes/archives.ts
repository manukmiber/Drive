// /api/archives — download a selection as one archive (SPEC §7). ZIP formats stream immediately;
// TAR.ZST (and deflate ZIPs above the stream limit) become async jobs listed by GET /.
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import { createArchive, estimateArchive, listArchives } from '../services/archives';
import type { AppBindings } from '../types';

export const archives = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json({ jobs: await listArchives(c.get('ctx'), c.get('user')!.id) }))
  .post(
    '/estimate',
    validate('json', z.object({ nodeIds: z.array(z.string().max(40)).min(1).max(1000) })),
    async (c) =>
      c.json(await estimateArchive(c.get('ctx'), c.get('user')!.id, c.req.valid('json').nodeIds)),
  )
  .post(
    '/',
    rateLimit('RL_DOWNLOAD', 'archive'),
    validate(
      'json',
      z.object({
        nodeIds: z.array(z.string().max(40)).min(1).max(1000),
        format: z.enum(['zip_store', 'zip_deflate', 'tar_zst']).default('zip_store'),
        level: z.enum(['fast', 'normal', 'max']).optional(),
      }),
    ),
    async (c) =>
      c.json(await createArchive(c.get('ctx'), c.get('user')!.id, c.req.valid('json')), 201),
  );
