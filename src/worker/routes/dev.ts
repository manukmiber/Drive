// Dev-only helpers (APP_ENV=dev). Never mounted in staging/production.
import { Hono } from 'hono';
import { DEV_MAIL_PREFIX } from '../adapters/email';
import type { AppBindings } from '../types';

export const dev = new Hono<AppBindings>()
  .use('*', async (c, next) => {
    if (c.env.APP_ENV !== 'dev') return c.text('Not found', 404);
    await next();
  })
  .get('/mail', async (c) => {
    const list = await c.env.CONFIG_KV.list({ prefix: DEV_MAIL_PREFIX });
    const mails = await Promise.all(
      list.keys.map(
        async (k) => JSON.parse((await c.env.CONFIG_KV.get(k.name)) ?? 'null') as unknown,
      ),
    );
    return c.json({ mails: mails.filter(Boolean).reverse() });
  });
