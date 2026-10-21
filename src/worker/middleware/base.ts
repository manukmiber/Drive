import type { MiddlewareHandler } from 'hono';
import { createCtx } from '../context';
import { AppError } from '../lib/errors';
import type { AppBindings } from '../types';

export const requestContext: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set('requestId', c.req.header('cf-ray') ?? crypto.randomUUID());
  c.set('ctx', createCtx(c.env));
  c.set('user', null);
  await next();
};

/** True when the request targets USERCONTENT_ORIGIN (user content previews, SPEC §14.4). */
export function isUserContentHost(url: URL, env: { USERCONTENT_ORIGIN: string }): boolean {
  return url.host === new URL(env.USERCONTENT_ORIGIN).host;
}

/**
 * The user-content host only serves signed previews (`/p/...`, Fase 4). Everything else → 404, so
 * the app, API and cookies never live on that origin.
 */
export const userContentGuard: MiddlewareHandler<AppBindings> = async (c, next) => {
  const url = new URL(c.req.url);
  if (isUserContentHost(url, c.env) && !url.pathname.startsWith('/p/')) {
    return c.text('Not found', 404);
  }
  await next();
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Mutations must come from APP_ORIGIN (SPEC §14.4). Webhooks authenticate by signature instead. */
export const originCheck: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (MUTATING.has(c.req.method) && !c.req.path.startsWith('/api/webhooks/')) {
    const origin = c.req.header('origin');
    if (origin !== c.env.APP_ORIGIN) throw new AppError('ORIGIN_MISMATCH', 'origin not allowed');
  }
  await next();
};

export const apiHeaders: MiddlewareHandler<AppBindings> = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
};

export function appCsp(env: { USERCONTENT_ORIGIN: string }): string {
  const uc = new URL(env.USERCONTENT_ORIGIN).origin;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${uc}`,
    `media-src 'self' blob: ${uc}`,
    `connect-src 'self' ${uc}`,
    `frame-src ${uc}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
