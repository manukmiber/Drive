// The approval page's API (ADR-063): the person, signed in to Drive as usual (cookie session),
// sees what an app asks for and says yes or no. The app itself talks to /api/v1/oauth/*.
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { requireUser } from '../middleware/auth';
import { approve, checkAuthorize, deny } from '../services/oauth';
import type { AppBindings } from '../types';

const request = z.object({
  client_id: z.string().max(100),
  redirect_uri: z.string().max(2048),
  scope: z.string().max(500),
  state: z.string().max(512),
  code_challenge: z.string().max(128),
  code_challenge_method: z.string().max(10),
});

const asRequest = (q: z.infer<typeof request>) => ({
  clientId: q.client_id,
  redirectUri: q.redirect_uri,
  scope: q.scope,
  state: q.state,
  codeChallenge: q.code_challenge,
  codeChallengeMethod: q.code_challenge_method,
});

export const oauth = new Hono<AppBindings>()
  .use('*', requireUser)
  .get('/authorize', validate('query', request), (c) => {
    const ok = checkAuthorize(c.env.APP_ORIGIN, asRequest(c.req.valid('query')));
    return c.json({ client: ok.client, scopes: ok.scopes, redirectUri: ok.redirectUri });
  })
  .post('/authorize', validate('json', request.extend({ approve: z.boolean() })), async (c) => {
    const b = c.req.valid('json');
    return c.json(
      b.approve
        ? await approve(c.get('ctx'), c.get('user')!.id, asRequest(b))
        : deny(c.env.APP_ORIGIN, asRequest(b)),
    );
  });
