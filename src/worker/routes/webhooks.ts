// A6 (ADR-094): the person's webhook endpoints and their deliveries, under /api/webhooks.
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import {
  createWebhook,
  deleteWebhook,
  DRIVE_EVENTS,
  listDeliveries,
  listWebhooks,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
} from '../services/webhooks';
import type { AppBindings } from '../types';

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const events = z.array(z.enum(DRIVE_EVENTS)).max(DRIVE_EVENTS.length);
const url = z.string().trim().min(8).max(2048);
const description = z.string().trim().max(200).nullable();

export const webhooks = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) =>
    c.json({ items: await listWebhooks(c.get('ctx'), c.get('user')!.id), events: DRIVE_EVENTS }),
  )
  .post(
    '/',
    validate(
      'json',
      z.object({ url, events: events.default([]), description: description.optional() }),
    ),
    async (c) =>
      c.json(await createWebhook(c.get('ctx'), c.get('user')!.id, c.req.valid('json')), 201),
  )
  .get(
    '/deliveries',
    validate(
      'query',
      z.object({
        webhookId: id.optional(),
        s3: z.enum(['1', '0']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    ),
    async (c) => {
      const q = c.req.valid('query');
      return c.json({
        items: await listDeliveries(c.get('ctx'), c.get('user')!.id, {
          webhookId: q.webhookId,
          s3: q.s3 === '1',
          limit: q.limit,
        }),
      });
    },
  )
  .patch(
    '/:id',
    validate('param', z.object({ id })),
    validate(
      'json',
      z
        .object({
          url: url.optional(),
          events: events.optional(),
          description: description.optional(),
          enabled: z.boolean().optional(),
        })
        .refine((b) => Object.keys(b).length > 0),
    ),
    async (c) =>
      c.json({
        webhook: await updateWebhook(
          c.get('ctx'),
          c.get('user')!.id,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
      }),
  )
  .post('/:id/rotate', validate('param', z.object({ id })), async (c) =>
    c.json({
      secret: await rotateWebhookSecret(c.get('ctx'), c.get('user')!.id, c.req.valid('param').id),
    }),
  )
  .post('/:id/test', validate('param', z.object({ id })), async (c) => {
    await testWebhook(c.get('ctx'), c.get('user')!.id, c.req.valid('param').id);
    return c.body(null, 202);
  })
  .delete('/:id', validate('param', z.object({ id })), async (c) => {
    await deleteWebhook(c.get('ctx'), c.get('user')!.id, c.req.valid('param').id);
    return c.body(null, 204);
  });
