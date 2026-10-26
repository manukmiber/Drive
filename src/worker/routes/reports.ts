// POST /api/public/reports — "Laporkan penyalahgunaan" (anyone, logged in or not; SPEC §14.3).
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { verifyTurnstile } from '../lib/turnstile';
import { clientIp, rateLimit } from '../middleware/ratelimit';
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
      turnstileToken: z.string().max(4096).nullable().optional(),
    }),
  ),
  async (c) => {
    const { turnstileToken, ...input } = c.req.valid('json');
    const user = c.get('user');
    // Signed-in reporters are already rate-limited per account; anonymous ones prove they're human.
    // Without Turnstile here an anonymous report still lands, but only a moderator acts on it.
    const human = user
      ? true
      : await verifyTurnstile(c.get('ctx'), turnstileToken, clientIp(c.req.raw));
    const r = await createReport(c.get('ctx'), {
      ...input,
      reporterUserId: user?.id ?? null,
      accountable: human,
    });
    return c.json({ id: r.id, priority: r.priority }, 201);
  },
);
