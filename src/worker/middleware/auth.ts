import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { COOKIE_PREFIX, getAuth } from '../auth';
import { AppError } from '../lib/errors';
import { randomBase62 } from '../lib/ids';
import { timingSafeEqual } from '../lib/crypto';
import type { AppBindings, SessionUser } from '../types';

export const CSRF_COOKIE = `${COOKIE_PREFIX}.csrf`;
export const CSRF_HEADER = 'x-csrf-token';

/** Resolves the Better Auth session (if any) into c.var.user. */
export const loadSession: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = getAuth(c.get('ctx'));
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (result) {
    const u = result.user as typeof result.user & Partial<SessionUser>;
    c.set('user', { id: u.id, email: u.email, name: u.name, status: u.status ?? 'active' });
  }
  await next();
};

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const user = c.get('user');
  if (!user) throw new AppError('UNAUTHORIZED', 'sign in required');
  if (user.status !== 'active')
    throw new AppError('FORBIDDEN', 'account suspended', { reason: user.status });
  await next();
};

export function ensureCsrfCookie(c: Parameters<MiddlewareHandler<AppBindings>>[0]): string {
  let token = getCookie(c, CSRF_COOKIE);
  if (!token || !/^[0-9A-Za-z]{32}$/.test(token)) {
    token = randomBase62(32);
    setCookie(c, CSRF_COOKIE, token, { path: '/', secure: true, sameSite: 'Lax', httpOnly: false });
  }
  return token;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Double-submit CSRF token for our own API (Better Auth checks Origin itself; webhooks are signed;
 * share-link password forms carry their own token).
 */
export const csrfCheck: MiddlewareHandler<AppBindings> = async (c, next) => {
  const path = c.req.path;
  // CSRF only matters when the request carries a session (an ambient credential). Anonymous
  // mutations (abuse reports) are still covered by the Origin check.
  if (
    MUTATING.has(c.req.method) &&
    c.get('user') &&
    !path.startsWith('/api/auth/') &&
    !path.startsWith('/api/webhooks/')
  ) {
    const cookie = getCookie(c, CSRF_COOKIE) ?? '';
    const header = c.req.header(CSRF_HEADER) ?? '';
    if (!cookie || !timingSafeEqual(cookie, header))
      throw new AppError('CSRF', 'missing or bad CSRF token');
  }
  await next();
};
