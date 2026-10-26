// Managing one's own access tokens from Settings (ADR-061). Cookie session only: a token cannot
// make or list tokens.
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { createToken, listTokens, revokeToken, TOKEN_SCOPES } from '../services/tokens';
import type { AppBindings } from '../types';

export const tokens = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/', async (c) => c.json({ tokens: await listTokens(c.get('ctx'), c.get('user')!.id) }))
  .post(
    '/',
    validate(
      'json',
      z.object({
        name: z.string().min(1).max(80),
        scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
        expiresInDays: z.number().int().min(1).max(3650).nullable(),
      }),
    ),
    async (c) =>
      c.json(await createToken(c.get('ctx'), c.get('user')!.id, c.req.valid('json')), 201),
  )
  .delete('/:id', async (c) => {
    await revokeToken(c.get('ctx'), c.get('user')!.id, c.req.param('id'));
    return c.body(null, 204);
  });
