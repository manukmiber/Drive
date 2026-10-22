import { Hono } from 'hono';
import type { AppBindings } from '../types';

/**
 * Where the browser signs in (ADR-036): the Zeiko Accounts door it asks for a ticket, and the
 * website whose pages sign people in and take payments. In dev both are the stand-in door.
 */
export const publicAuth = new Hono<AppBindings>().get('/auth', (c) => {
  const dev = c.env.APP_ENV === 'dev';
  const origin = new URL(c.req.url).origin;
  return c.json({
    doorUrl: dev ? `${origin}/__dev/door` : (c.env.ZEIKO_DOOR_URL ?? null),
    siteUrl: dev ? `${origin}/__dev/door` : (c.env.ZEIKO_SITE_URL ?? null),
    basePath: c.env.APP_BASE_PATH ?? '/dashboard',
    chatUrl: 'https://chat.zeiko.biz.id',
    // Still used by share emails, abuse reports and advertiser sign-up.
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? null,
    dev,
  });
});
