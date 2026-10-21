import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { JSON_BODY_MAX_BYTES } from '../shared/constants';
import { getAuth } from './auth';
import { AppError } from './lib/errors';
import { csrfCheck, loadSession } from './middleware/auth';
import { clientIp, enforceRateLimit } from './middleware/ratelimit';
import {
  apiHeaders,
  appCsp,
  originCheck,
  requestContext,
  userContentGuard,
} from './middleware/base';
import { errorBody, onError } from './middleware/errors';
import { admin } from './routes/admin';
import { catalog } from './routes/catalog';
import { dev } from './routes/dev';
import { download } from './routes/download';
import { health } from './routes/health';
import { me } from './routes/me';
import { nodes } from './routes/nodes';
import { preview } from './routes/preview';
import { publicAuth } from './routes/public-auth';
import { reports } from './routes/reports';
import { archiveDownload } from './routes/archive-download';
import { integrations } from './routes/integrations';
import { sharePublic } from './routes/share-public';
import { shares } from './routes/shares';
import { uploads } from './routes/uploads';
import { archives } from './routes/archives';
import { billing } from './routes/billing';
import { payments } from './routes/payments';
import { notifications } from './routes/notifications';
import type { AppBindings } from './types';

export function createApp() {
  const app = new Hono<AppBindings>();

  app.use('*', userContentGuard, requestContext);

  // Webhooks authenticate with their own secret (no Origin/CSRF), so they sit before /api.
  app.route('/', integrations);
  app.route('/', payments);

  const api = new Hono<AppBindings>();
  api.use('*', apiHeaders, originCheck);

  // Better Auth owns /api/auth/* (sessions, OTP, OAuth, passkeys, TOTP).
  api.on(['GET', 'POST'], '/auth/*', async (c) => {
    if (c.req.method === 'POST') {
      await enforceRateLimit(c.env, 'RL_AUTH', `auth:${clientIp(c.req.raw)}`);
    }
    return getAuth(c.get('ctx')).handler(c.req.raw);
  });

  // JSON routes are small; upload parts (binary) are mounted with their own limits.
  const jsonLimit = bodyLimit({
    maxSize: JSON_BODY_MAX_BYTES,
    onError: () => {
      throw new AppError('PAYLOAD_TOO_LARGE', 'request body too large');
    },
  });
  api.use('*', async (c, next) => {
    const type = c.req.header('content-type') ?? '';
    return type.includes('application/json') ? jsonLimit(c, next) : next();
  });
  api.use('*', loadSession, csrfCheck);
  api.route('/', health);
  api.route('/public', catalog);
  api.route('/public', publicAuth);
  api.route('/public', reports);
  api.route('/me', me);
  api.route('/admin', admin);
  api.route('/uploads', uploads);
  api.route('/shares', shares);
  api.route('/archives', archives);
  api.route('/billing', billing);
  api.route('/notifications', notifications);
  api.route('/', nodes);
  api.all('*', (c) => c.json(errorBody('NOT_FOUND', 'no such endpoint'), 404));
  app.route('/api', api);

  app.route('/d', download);
  app.route('/p', preview);
  app.route('/z', archiveDownload);
  app.route('/', sharePublic);
  app.route('/__dev', dev);

  // Web Share Target without the service worker (first launch) → just open the Drive.
  app.post('/share-target', (c) => c.redirect('/drive', 303));

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
