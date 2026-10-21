import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { and, count, eq } from 'drizzle-orm';
import { COOKIE_PREFIX, getAuth } from '../auth';
import { schema } from '../db/client';
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
    c.set('user', {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role ?? 'user',
      status: u.status ?? 'active',
      twoFactorEnabled: Boolean(u.twoFactorEnabled),
    });
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

/**
 * Admin/moderator routes: role check plus a second factor on the account — TOTP enabled or at
 * least one passkey (SPEC §13.1 "wajib passkey/TOTP").
 */
export function requireStaff(
  roles: Array<SessionUser['role']> = ['admin'],
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw new AppError('UNAUTHORIZED', 'sign in required');
    if (!roles.includes(user.role)) throw new AppError('FORBIDDEN', 'staff only');
    if (!user.twoFactorEnabled) {
      const { db } = c.get('ctx');
      const row = await db
        .select({ n: count() })
        .from(schema.passkeys)
        .where(and(eq(schema.passkeys.userId, user.id)))
        .get();
      if (!row || row.n === 0) {
        throw new AppError('FORBIDDEN', 'second factor required', { reason: 'ADMIN_2FA_REQUIRED' });
      }
    }
    await next();
  };
}

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
