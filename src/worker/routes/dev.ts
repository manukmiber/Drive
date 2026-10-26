// Dev-only helpers (APP_ENV=dev). Never mounted in staging/production.
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { DEV_MAIL_PREFIX } from '../adapters/email';
import { MockZeikoAccounts, type ZeikoAccount } from '../adapters/zeiko';
import { escapeHtml } from '../services/email-templates';
import type { AppBindings } from '../types';

/** The stand-in door's session: just the email it signed in as (dev only). */
const DOOR_COOKIE = 'zkdev_door';
const DEMO = ['demo@zeiko.local', 'max@zeiko.local', 'baru@zeiko.local'];

/** The Zeiko Account a dev email stands for: a stable id per address. */
export function devAccount(email: string): ZeikoAccount {
  const slug = email.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return {
    id: `zk_${slug}`,
    email,
    username: slug.slice(0, 30),
    name: email.split('@')[0] ?? email,
    emailVerified: true,
    city: 'Bandung',
    postalCode: '40115',
  };
}

/**
 * Where the stand-in door may send a browser back to, as the website does: a page of this app at
 * its own address (`origin`), or a path of ours.
 */
function safeNext(next: string | undefined, origin: string): string {
  if (!next) return '/';
  if (/^\/(?!\/)[\w\-/]*(\?[\w=&%.-]*)?$/.test(next)) return next;
  try {
    const u = new URL(next);
    return u.origin === origin && !u.hash && /^\/(?!\/)[\w\-/]*$/.test(u.pathname) ? u.href : '/';
  } catch {
    return '/';
  }
}

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
  })
  // A stand-in for the Zeiko Accounts door (ADR-036): the same /v1 calls the SPA makes in
  // production, and a sign-in page with the demo accounts in place of the website's.
  .get('/door/v1/session', (c) => {
    const email = getCookie(c, DOOR_COOKIE);
    return c.json({ account: email ? devAccount(email) : null, signInWith: {} });
  })
  .post('/door/v1/ticket', async (c) => {
    const email = getCookie(c, DOOR_COOKIE);
    if (!email) return c.json({ error: { code: 'signed_out', message: 'Sign in first.' } }, 401);
    return c.json({
      ticket: await MockZeikoAccounts.issue(c.env.CONFIG_KV, devAccount(email)),
      expiresIn: 120,
    });
  })
  .post('/door/v1/logout', (c) => {
    deleteCookie(c, DOOR_COOKIE, { path: '/' });
    return c.json({ ok: true });
  })
  .get('/door/v1/account', (c) => {
    const email = getCookie(c, DOOR_COOKIE);
    if (!email) return c.json({ error: { code: 'signed_out', message: 'Sign in first.' } }, 401);
    return c.json({
      account: devAccount(email),
      // The shape of the real door's /v1/account, as far as the AI Decision page reads it.
      plan: {
        id: 'welcome',
        name: 'Welcome',
        paygo: false,
        requests: 100,
        expiresAt: Date.now() + 20 * 86_400_000,
      },
      usage: {
        used: 27,
        amount: 100,
        periodStart: Date.now() - 86_400_000,
        resetsAt: Date.now() + 29 * 86_400_000,
      },
      balance: { micro: 2_500_000, text: '$2.50', shared: true },
      key: { id: 'key_dev', masked: 'zk-…dev1', enabled: true },
      chat: { plan: 'free', planName: 'Free', expiresAt: null },
    });
  })
  .get('/door/v1/key', (c) =>
    getCookie(c, DOOR_COOKIE)
      ? c.json({ key: 'zk-dev-not-a-real-key-0000' })
      : c.json({ error: { code: 'signed_out', message: 'Sign in first.' } }, 401),
  )
  // Sign-in and sign-up are one page here: any email makes an account.
  .on(['GET', 'POST'], ['/door/account/signin', '/door/account/signup'], async (c) => {
    const next = safeNext(c.req.query('next'), c.env.APP_ORIGIN);
    if (c.req.method === 'POST') {
      const form = await c.req.parseBody();
      // A demo button sends `email`; the box (and its own button) sends `typed`.
      const email = String(form.email ?? form.typed ?? '')
        .trim()
        .toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return c.text('bad email', 400);
      setCookie(c, DOOR_COOKIE, email, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: true,
      });
      return c.redirect(next, 303);
    }
    const pick = DEMO.map(
      (e) => `<button name="email" value="${e}">${escapeHtml(e)}</button>`,
    ).join('');
    return c.html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev door</title>
<body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<h1>Stand-in Zeiko Accounts door</h1><p>Dev only. Pick a demo account, or type any email.</p>
<form method="post">${pick}<p><input name="typed" type="email" placeholder="you@example.com"> <button>Sign in</button></p></form></body>`);
  });
