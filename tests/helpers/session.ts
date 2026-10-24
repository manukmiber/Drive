import { expect } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { MockZeikoAccounts, type ZeikoAccount } from '../../src/worker/adapters/zeiko';
import { APP } from './runtime';

/** Minimal cookie jar for fetch-based tests. */
export class Jar {
  private cookies = new Map<string, string>();
  absorb(res: Response): Response {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      if (/max-age=0/i.test(sc) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
}

export interface Session {
  jar: Jar;
  csrf: string;
  userId: string;
  /** Authenticated request with Origin + CSRF headers. */
  req(method: string, path: string, body?: unknown, extra?: RequestInit): Promise<Response>;
}

/** The Zeiko Account a test email stands for (ADR-036): a stable id per address. */
export function zeikoAccountFor(email: string, over: Partial<ZeikoAccount> = {}): ZeikoAccount {
  const slug = email.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return {
    id: `zk_${slug}`,
    email,
    username: slug.slice(0, 30),
    name: email.split('@')[0] ?? email,
    emailVerified: true,
    city: '',
    postalCode: '',
    ...over,
  };
}

/** What the browser does: get a ticket from the (mock) door, hand it to our exchange. */
export async function exchange(
  rt: DevRuntime,
  jar: Jar,
  account: ZeikoAccount,
  locale?: 'id' | 'en',
): Promise<Response> {
  const ticket = await MockZeikoAccounts.issue(rt.env.CONFIG_KV, account);
  return jar.absorb(
    await rt.fetch(
      new Request(`${APP}/api/auth/zeiko/exchange`, {
        method: 'POST',
        headers: { origin: APP, 'content-type': 'application/json', cookie: jar.header() },
        body: JSON.stringify({ ticket, ...(locale ? { locale } : {}) }),
      }),
    ),
  );
}

export async function signIn(
  rt: DevRuntime,
  email: string,
  over: Partial<ZeikoAccount> = {},
): Promise<Session> {
  const jar = new Jar();
  const signed = await exchange(rt, jar, zeikoAccountFor(email, over));
  expect(signed.status, await signed.clone().text()).toBe(200);

  const meRes = jar.absorb(
    await rt.fetch(new Request(`${APP}/api/me`, { headers: { cookie: jar.header() } })),
  );
  expect(meRes.status).toBe(200);
  const me = (await meRes.json()) as { user: { id: string }; csrfToken: string };

  return {
    jar,
    csrf: me.csrfToken,
    userId: me.user.id,
    req: async (method, path, body, extra = {}) => {
      const headers = new Headers(extra.headers);
      headers.set('origin', APP);
      headers.set('cookie', jar.header());
      headers.set('x-csrf-token', me.csrfToken);
      let payload = extra.body;
      if (body !== undefined) {
        headers.set('content-type', 'application/json');
        payload = JSON.stringify(body);
      }
      const res = await rt.fetch(
        new Request(`${APP}${path}`, { ...extra, method, headers, body: payload ?? null }),
      );
      return jar.absorb(res);
    },
  };
}

/** An admin (or moderator) with a second factor, as staff-only routes want (SPEC §13.1). */
export async function staffSignIn(
  rt: DevRuntime,
  email: string,
  role: 'admin' | 'moderator' = 'admin',
  over: Partial<ZeikoAccount> = {},
): Promise<Session> {
  const s = await signIn(rt, email, over);
  rt.d1.sqlite
    .prepare('UPDATE users SET role = ?, two_factor_enabled = 1 WHERE id = ?')
    .run(role, s.userId);
  return signIn(rt, email, over); // a fresh session carries the new role
}
