import { Hono } from 'hono';
import {
  apiHeaders,
  appCsp,
  originCheck,
  requestContext,
  userContentGuard,
} from './middleware/base';
import { errorBody, onError } from './middleware/errors';
import { catalog } from './routes/catalog';
import { dev } from './routes/dev';
import { health } from './routes/health';
import type { AppBindings } from './types';

export function createApp() {
  const app = new Hono<AppBindings>();

  app.use('*', userContentGuard, requestContext);

  const api = new Hono<AppBindings>();
  api.use('*', apiHeaders, originCheck);
  api.route('/', health);
  api.route('/public', catalog);
  api.all('*', (c) => c.json(errorBody('NOT_FOUND', 'no such endpoint'), 404));
  app.route('/api', api);

  app.route('/__dev', dev);

  // Everything else is the SPA / static assets (run_worker_first, see wrangler.jsonc).
  app.all('*', async (c) => {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('text/html')) return res;
    const out = new Response(res.body, res);
    out.headers.set('Content-Security-Policy', appCsp(c.env));
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    out.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return out;
  });

  app.onError(onError);
  return app;
}
