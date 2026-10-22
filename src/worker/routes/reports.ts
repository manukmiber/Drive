// POST /api/public/reports — "Laporkan penyalahgunaan" (anyone, logged in or not; SPEC §14.3).
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { rateLimit } from '../middleware/ratelimit';
import { createReport, REPORT_CATEGORIES } from '../services/reports';
import type { AppBindings } from '../types';

export const reports = new Hono<AppBindings>().post(
  '/reports',
  rateLimit('RL_REPORT', 'report'),
  validate(
    'json',
    z.object({
      targetType: z.enum(['share', 'node', 'ad']),
      targetId: z.string().min(10).max(80),
      category: z.enum(REPORT_CATEGORIES),
      details: z.string().max(2000).optional(),
      contact: z.string().max(200).optional(),
    }),
  ),
  async (c) => {
    const r = await createReport(c.get('ctx'), {
      ...c.req.valid('json'),
      reporterUserId: c.get('user')?.id ?? null,
    });
    return c.json({ id: r.id, priority: r.priority }, 201);
  },
);
