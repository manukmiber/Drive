import { Hono } from 'hono';
import type { AppBindings } from '../types';

export const health = new Hono<AppBindings>().get('/health', async (c) => {
  const ctx = c.get('ctx');
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1, env: c.env.APP_ENV, time: ctx.now() });
});
