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
import { compress } from './routes/compress';
import { adPublic, adsApi, advertiser } from './routes/ads';
import { billing } from './routes/billing';
import { payments } from './routes/payments';
import { ops } from './routes/ops';
import { tokens } from './routes/tokens';
import { v1 } from './routes/v1';
import { notifications } from './routes/notifications';
import { family } from './routes/family';
import { s3 } from './routes/s3';
import { handleS3, resolveS3Host } from './routes/s3-api';
import { createCtx } from './context';
import type { AppBindings } from './types';
import { appPath, basePath } from './lib/paths';

export function createApp() {
  const app = new Hono<AppBindings>();

  // Zeiko S3 has a host of its own, and own addresses (ADR-048), and speaks S3, not this app's API.
  app.use('*', async (c, next) => {
    const host = await resolveS3Host(new URL(c.req.url), c.env);
    if (!host) return next();
    let waitUntil: ((p: Promise<unknown>) => void) | undefined;
    try {
      const exec = c.executionCtx;
      waitUntil = (p) => exec.waitUntil(p);
    } catch {
      // No execution context (tests): handleS3 awaits instead.
    }
    return handleS3(c.req.raw, createCtx(c.env), waitUntil, host.owner);
  });
  app.use('*', userContentGuard, requestContext);

  // Webhooks and the relay's ops API authenticate with their own secret (no Origin/CSRF), so
  // they sit before /api.
  app.route('/', integrations);
  app.route('/', payments);
  app.route('/api/ops', ops);
  // The public API (ADR-061): Bearer tokens, no session cookie, no Origin/CSRF.
  app.route('/api/v1', v1);

  const api = new Hono<AppBindings>();
  api.use('*', apiHeaders, originCheck);

  // Better Auth owns /api/auth/* (the Zeiko Accounts exchange and sessions).
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
  api.route('/uploads', uploads);
  api.route('/shares', shares);
  api.route('/archives', archives);
  api.route('/compress', compress);
  api.route('/ads', adsApi);
  api.route('/advertiser', advertiser);
  api.route('/billing', billing);
  api.route('/notifications', notifications);
  api.route('/family', family);
  api.route('/s3', s3);
  api.route('/tokens', tokens);
  api.route('/', nodes);
  api.all('*', (c) => c.json(errorBody('NOT_FOUND', 'no such endpoint'), 404));
  app.route('/api', api);

  app.route('/d', download);
  app.route('/p', preview);
  app.route('/z', archiveDownload);
  app.route('/ad', adPublic);
  app.route('/', sharePublic);
  app.route('/__dev', dev);

  // Web Share Target without the service worker (first launch) → just open the Drive.
  app.post('/share-target', (c) => c.redirect(appPath(c.env, '/drive'), 303));

  // Everything else is the SPA / static assets (run_worker_first, see wrangler.jsonc). The SPA is
  // at the root of Drive's own address (ADR-038), or under APP_BASE_PATH when one is set.
  app.all('*', async (c) => {
    const url = new URL(c.req.url);
    const base = basePath(c.env);
    // The app used to be at zeiko.biz.id/dashboard (ADR-036), and the website still sends people
    // back here through that path: /dashboard/drive is /drive.
    if (!base && /^\/dashboard(\/|$)/.test(url.pathname)) {
      // One leading slash only: "//host" would send the browser to another site (ADR-056).
      const rest = `/${url.pathname.slice('/dashboard'.length).replace(/^[/\\]+/, '')}`;
      return c.redirect(`${rest}${url.search}`, 301);
    }
    if (base && (url.pathname === '/' || url.pathname === base)) return c.redirect(`${base}/`, 302);
    if (c.req.method === 'POST' && url.pathname === `${base}/share-target`)
      return c.redirect(appPath(c.env, '/drive'), 303);
    let res = await c.env.ASSETS.fetch(c.req.raw);
    if (
      res.status === 404 &&
      url.pathname.startsWith(`${base}/`) &&
      !/\.[a-z0-9]+$/i.test(url.pathname)
    ) {
      res = await c.env.ASSETS.fetch(new Request(new URL(`${base}/index.html`, url)));
    }
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
