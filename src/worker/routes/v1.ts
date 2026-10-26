// The public API, version 1 (ADR-061; grown in A2): Bearer access tokens only, no cookies, no
// CSRF. Breaking changes go to /api/v2; new fields may be added here.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { JSON_BODY_MAX_BYTES } from '../../shared/constants';
import { AppError } from '../lib/errors';
import { apiHeaders } from '../middleware/base';
import { errorBody } from '../middleware/errors';
import { tokenAuth } from '../middleware/token';
import type { AppBindings } from '../types';

export const v1 = new Hono<AppBindings>()
  .use(
    '*',
    apiHeaders,
    bodyLimit({
      maxSize: JSON_BODY_MAX_BYTES,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', 'request body too large');
      },
    }),
    tokenAuth,
  )
  // Who the token belongs to and what it may do.
  .get('/me', (c) => {
    const auth = c.get('token')!;
    return c.json({
      user: { id: auth.user.id, email: auth.user.email, name: auth.user.name },
      token: {
        id: auth.token.id,
        name: auth.token.name,
        scopes: auth.scopes,
        expiresAt: auth.token.expires_at,
      },
    });
  })
  .all('*', (c) => c.json(errorBody('NOT_FOUND', 'no such endpoint'), 404));
