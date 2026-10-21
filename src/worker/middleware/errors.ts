import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { errorMessage, log } from '../lib/log';
import type { AppBindings } from '../types';

export function errorBody(code: string, message: string, data?: Record<string, unknown>) {
  return { error: { code, message, ...(data ? { data } : {}) } };
}

export function onError(err: Error, c: Context<AppBindings>): Response {
  if (err instanceof AppError) {
    return c.json(errorBody(err.code, err.message, err.data), err.status as 400);
  }
  if (err instanceof ZodError) {
    return c.json(errorBody('VALIDATION', 'invalid request', { issues: err.issues }), 400);
  }
  if (err instanceof HTTPException) {
    return c.json(errorBody('BAD_REQUEST', err.message), err.status);
  }
  log.error('unhandled_error', {
    requestId: c.get('requestId'),
    path: new URL(c.req.url).pathname,
    message: errorMessage(err),
  });
  return c.json(errorBody('INTERNAL', 'internal error'), 500);
}
