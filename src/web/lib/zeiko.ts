// Zeiko Accounts from the browser (ADR-036). The page is on the website's own address, so the
// browser already holds the door's session (its cookie, on the door's host): we ask the door for
// a one-time ticket and hand it to our Worker, which redeems it server to server. The door's
// posts need `X-Zeiko: 1` and our origin, which it allows.
import { api, postJson } from './api';
import { lang } from './i18n';
import type { PublicAuth } from './types';

let config: Promise<PublicAuth> | null = null;

export function zeikoConfig(): Promise<PublicAuth> {
  config ??= api<PublicAuth>('/api/public/auth');
  return config;
}

interface DoorAnswer {
  status: number;
  data: Record<string, unknown> | null;
}

/** One call to the door's /v1; status 0 when it did not answer within 15 s. */
export async function door(method: 'GET' | 'POST', path: string, body?: unknown): Promise<DoorAnswer> {
  const cfg = await zeikoConfig();
  if (!cfg.doorUrl) return { status: 0, data: null };
  try {
    const res = await fetch(`${cfg.doorUrl.replace(/\/+$/, '')}/v1${path}`, {
      method,
      credentials: 'include',
      headers: method === 'GET' ? {} : { 'x-zeiko': '1', 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, data: (await res.json().catch(() => null)) as DoorAnswer['data'] };
  } catch {
    return { status: 0, data: null };
  }
}

export type SilentResult = 'signed-in' | 'no-session' | 'unverified' | 'unavailable';

/** Sign in with the door session this browser already has, if any. */
export async function signInSilently(): Promise<SilentResult> {
  const s = await door('GET', '/session');
  if (s.status !== 200) return 'unavailable';
  const account = s.data?.account as { emailVerified?: boolean; email?: string } | null | undefined;
  if (!account) return 'no-session';
  if (!account.email || !account.emailVerified) return 'unverified';
  const t = await door('POST', '/ticket', { app: 'drive' });
  if (t.status !== 200 || typeof t.data?.ticket !== 'string') return 'unavailable';
  try {
    await postJson('/api/auth/zeiko/exchange', { ticket: t.data.ticket, locale: lang });
    return 'signed-in';
  } catch (e) {
    return (e as { status?: number }).status === 403 ? 'unverified' : 'unavailable';
  }
}

/** The website's page for `page` (signin, signup, settings …), coming back to `next` after. */
export async function sitePage(page: string, next?: string): Promise<string | null> {
  const cfg = await zeikoConfig();
  if (!cfg.siteUrl) return null;
  const base = cfg.siteUrl.replace(/\/+$/, '');
  return `${base}/account${page ? `/${page}` : ''}${next ? `?next=${encodeURIComponent(next)}` : ''}`;
}

/** Sign out of the door too: otherwise the next visit signs straight back in. */
export async function signOutOfDoor(): Promise<void> {
  await door('POST', '/logout', {});
}
