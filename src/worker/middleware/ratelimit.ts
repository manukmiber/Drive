import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import type { AppBindings } from '../types';

export type RateLimitBinding =
  | 'RL_AUTH'
  | 'RL_UPLOAD'
  | 'RL_SHARE_CREATE'
  | 'RL_SHARE_SEND'
  | 'RL_DOWNLOAD'
  | 'RL_AD_BOOK'
  | 'RL_REPORT'
  /** Per access token on /api/v1 (ADR-061). */
  | 'RL_API';

export function clientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    '0.0.0.0'
  );
}

export async function enforceRateLimit(
  env: Env,
  binding: RateLimitBinding,
  key: string,
): Promise<void> {
  const { success } = await env[binding].limit({ key });
  if (!success) throw new AppError('RATE_LIMITED', 'too many requests');
}

/** Rate limit keyed by user (when signed in) or client IP, plus a route scope. */
export function rateLimit(
  binding: RateLimitBinding,
  scope: string,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const who = c.get('user')?.id ?? clientIp(c.req.raw);
    await enforceRateLimit(c.env, binding, `${scope}:${who}`);
    await next();
  };
}
