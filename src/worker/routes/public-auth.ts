import { Hono } from 'hono';
import type { AppBindings } from '../types';

/**
 * Where the browser signs in (ADR-036): the Zeiko Accounts door it asks for a ticket, and the
 * website whose pages sign people in and take payments. In dev both are the stand-in door.
 */
export const publicAuth = new Hono<AppBindings>().get('/auth', (c) => {
  const dev = c.env.APP_ENV === 'dev';
  // The app's own address, not this request's: in dev the API sits behind Vite's proxy on another
  // port, and the stand-in door must be on the app's site for its cookie to be sent.
  const origin = c.env.APP_ORIGIN;
  return c.json({
    doorUrl: dev ? `${origin}/__dev/door` : (c.env.ZEIKO_DOOR_URL ?? null),
    siteUrl: dev ? `${origin}/__dev/door` : (c.env.ZEIKO_SITE_URL ?? null),
    chatUrl: 'https://chat.zeiko.biz.id',
    // Still used by share emails, abuse reports and advertiser sign-up.
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? null,
    dev,
  });
});
