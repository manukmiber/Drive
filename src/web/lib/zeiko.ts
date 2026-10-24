// Zeiko Accounts from the browser (ADR-036, ADR-038, ADR-039). The page is on drive.zeiko.biz.id,
// a subdomain of the website's, so the browser already holds the door's session (its cookie, on
// the door's host, sent to it from any page of zeiko.biz.id): we ask the door for a one-time ticket
// and hand it to our Worker, which redeems it server to server. The door's posts need
// `X-Zeiko: 1` and our origin, which it allows (Drive's address is on the door's list).
//
// The door's session is the one that counts. Drive's own session only stands for it: when the
// door says this browser is signed out, or signed in as somebody else, Drive follows
// (`doorAccount`, used by the app shell).
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
export async function door(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<DoorAnswer> {
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

interface DoorAccount {
  id?: string;
  email?: string;
  emailVerified?: boolean;
  /** Where they live, for local ads (ADR-041). */
  city?: string;
  postalCode?: string;
}

/**
 * Who this browser is signed in as at the door: an account, `null` when signed out there, or
 * `undefined` when the door did not answer (Drive then carries on as it is: ADR-036).
 */
export async function doorAccount(): Promise<DoorAccount | null | undefined> {
  const s = await door('GET', '/session');
  if (s.status !== 200 || !s.data) return undefined;
  const account = s.data.account as DoorAccount | null | undefined;
  return account && typeof account.id === 'string' ? account : null;
}

export type SilentResult = 'signed-in' | 'no-session' | 'unverified' | 'unavailable';

/** Sign in with the door session this browser already has, if any. */
export async function signInSilently(): Promise<SilentResult> {
  const account = await doorAccount();
  if (account === undefined) return 'unavailable';
  if (account === null) return 'no-session';
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

/**
 * The website's page for `page` (signin, signup, settings …). With `back`, a path of this app,
 * the website sends the visitor straight back to it here once they are signed in.
 */
export async function sitePage(page: string, back?: string): Promise<string | null> {
  const cfg = await zeikoConfig();
  if (!cfg.siteUrl) return null;
  const base = cfg.siteUrl.replace(/\/+$/, '');
  const next = back ? `?next=${encodeURIComponent(`${location.origin}${back}`)}` : '';
  return `${base}/account${page ? `/${page}` : ''}${next}`;
}

/** Sign out of the door too: otherwise the next visit signs straight back in. */
export async function signOutOfDoor(): Promise<void> {
  await door('POST', '/logout', {});
}
