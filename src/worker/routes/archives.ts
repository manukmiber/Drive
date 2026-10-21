// POST /api/archives — signed link for downloading a selection as one ZIP.
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import { createArchive } from '../services/archives';
import type { AppBindings } from '../types';

export const archives = new Hono<AppBindings>().use('*', requireUser).post(
  '/',
  rateLimit('RL_DOWNLOAD', 'archive'),
  validate(
    'json',
    z.object({
      nodeIds: z.array(z.string().max(40)).min(1).max(1000),
      format: z.enum(['zip_store', 'zip_deflate']).default('zip_store'),
    }),
  ),
  async (c) =>
    c.json(await createArchive(c.get('ctx'), c.get('user')!.id, c.req.valid('json')), 201),
);
