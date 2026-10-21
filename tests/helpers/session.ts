import { expect } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { DEV_MAIL_PREFIX } from '../../src/worker/adapters/email';
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

export async function lastOtp(rt: DevRuntime, email: string): Promise<string> {
  const list = await rt.env.CONFIG_KV.list({ prefix: DEV_MAIL_PREFIX });
  for (const k of [...list.keys].reverse()) {
    const mail = JSON.parse((await rt.env.CONFIG_KV.get(k.name)) ?? '{}') as {
      to: string[];
      subject: string;
    };
    if (mail.to?.includes(email)) {
      const m = /(\d{6})/.exec(mail.subject);
      if (m) return m[1]!;
    }
  }
  throw new Error(`no OTP mail for ${email}`);
}

export async function signIn(rt: DevRuntime, email: string): Promise<Session> {
  const jar = new Jar();
  const post = (path: string, body: unknown) =>
    rt
      .fetch(
        new Request(`${APP}${path}`, {
          method: 'POST',
          headers: { origin: APP, 'content-type': 'application/json', cookie: jar.header() },
          body: JSON.stringify(body),
        }),
      )
      .then((r) => jar.absorb(r));

  const sent = await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' });
  expect(sent.status, await sent.clone().text()).toBe(200);
  const otp = await lastOtp(rt, email);
  const signed = await post('/api/auth/sign-in/email-otp', { email, otp });
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
