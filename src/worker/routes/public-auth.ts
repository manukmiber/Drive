import { Hono } from 'hono';
import type { AppBindings } from '../types';

/** Which sign-in methods the client should offer. */
export const publicAuth = new Hono<AppBindings>().get('/auth', (c) =>
  c.json({
    google: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? null,
    devMailbox: c.env.APP_ENV === 'dev',
  }),
);
