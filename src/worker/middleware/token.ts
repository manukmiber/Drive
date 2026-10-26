// Bearer access tokens on /api/v1 (ADR-061): who the request is, at the token's rate.
import type { MiddlewareHandler } from 'hono';
import { authenticateToken, requireScope, type TokenScope } from '../services/tokens';
import type { AppBindings } from '../types';
import { enforceRateLimit } from './ratelimit';

export const tokenAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = await authenticateToken(c.get('ctx'), c.req.header('authorization'));
  await enforceRateLimit(c.env, 'RL_API', `token:${auth.token.id}`);
  c.set('user', auth.user);
  c.set('token', auth);
  await next();
};

/** The route needs this scope on the request's token. */
export function scope(s: TokenScope): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = c.get('token');
    if (!auth) throw new Error('scope() without tokenAuth');
    requireScope(auth, s);
    await next();
  };
}
