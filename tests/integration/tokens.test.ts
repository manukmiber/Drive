// Access tokens (ADR-061): made in Settings with the session cookie, used as Bearer on /api/v1 only.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createCtx } from '../../src/worker/context';
import { onError } from '../../src/worker/middleware/errors';
import { scope, tokenAuth } from '../../src/worker/middleware/token';
import { processAccountDeletions } from '../../src/worker/services/account';
import { TOKEN_RE } from '../../src/worker/services/tokens';
import type { AppBindings } from '../../src/worker/types';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn } from '../helpers/session';

interface Made {
  token: string;
  info: { id: string; prefix: string; scopes: string[]; expiresAt: number | null };
}

const bearer = (
  rt: Awaited<ReturnType<typeof makeRuntime>>,
  path: string,
  token: string,
  init: RequestInit = {},
) =>
  rt.fetch(
    new Request(`${APP}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    }),
  );

async function make(user: Awaited<ReturnType<typeof signIn>>, body: Record<string, unknown> = {}) {
  const res = await user.req('POST', '/api/tokens', {
    name: 'skrip backup',
    scopes: ['drive.read'],
    expiresInDays: 30,
    ...body,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Made;
}

describe('access tokens (ADR-061)', () => {
  it('shows the secret once, keeps only its hash, and signs in on /api/v1', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'token@zeiko.test');
    const made = await make(user, { scopes: ['drive.read', 'share'] });
    expect(made.token).toMatch(TOKEN_RE);
    expect(made.token.startsWith(made.info.prefix)).toBe(true);
    const row = rt.d1.sqlite
      .prepare('SELECT secret_hash, prefix FROM api_tokens WHERE id = ?')
      .get(made.info.id) as { secret_hash: string; prefix: string };
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(made.token);
    const list = await (await user.req('GET', '/api/tokens')).text();
    expect(list).toContain(made.info.prefix);
    expect(list).not.toContain(made.token);
    expect(list).not.toContain(row.secret_hash);

    const me = await bearer(rt, '/api/v1/me', made.token);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { id: string }; token: { scopes: string[] } };
    expect(body.user.id).toBe(user.userId);
    expect(body.token.scopes).toEqual(['drive.read', 'share']);
    const used = rt.d1.sqlite
      .prepare('SELECT last_used_at FROM api_tokens WHERE id = ?')
      .get(made.info.id) as { last_used_at: number | null };
    expect(used.last_used_at).not.toBeNull();
  });

  it('refuses wrong, malformed, missing, expired and revoked tokens alike', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'token@zeiko.test');
    const made = await make(user);
    const wrongSecret = made.info.prefix + 'x'.repeat(32);
    for (const t of [wrongSecret, 'zkd_short', 'Basic abc', '', `${made.token}x`]) {
      const res = await bearer(rt, '/api/v1/me', t);
      expect(res.status, t).toBe(401);
    }
    expect((await rt.fetch(new Request(`${APP}/api/v1/me`))).status).toBe(401);

    rt.d1.sqlite.prepare('UPDATE api_tokens SET expires_at = 1 WHERE id = ?').run(made.info.id);
    expect((await bearer(rt, '/api/v1/me', made.token)).status).toBe(401);
    rt.d1.sqlite.prepare('UPDATE api_tokens SET expires_at = NULL WHERE id = ?').run(made.info.id);
    expect((await bearer(rt, '/api/v1/me', made.token)).status).toBe(200);

    expect((await user.req('DELETE', `/api/tokens/${made.info.id}`)).status).toBe(204);
    expect((await bearer(rt, '/api/v1/me', made.token)).status).toBe(401);
    expect((await user.req('DELETE', `/api/tokens/${made.info.id}`)).status).toBe(404);
    expect(
      ((await (await user.req('GET', '/api/tokens')).json()) as { tokens: unknown[] }).tokens,
    ).toEqual([]);
  });

  it('is not accepted by the cookie API or ops, and cannot make tokens', async () => {
    const rt = await makeRuntime({ vars: { ZEIKO_OPS_TOKEN: 'o'.repeat(40) } });
    const user = await signIn(rt, 'token@zeiko.test');
    const made = await make(user, {
      scopes: ['drive.read', 'drive.write', 'share', 'webdav', 's3.manage'],
    });
    const cookieRoute = await bearer(rt, '/api/me', made.token);
    expect(cookieRoute.status).toBe(401);
    expect(await cookieRoute.text()).toContain('token_not_accepted_here');
    expect((await bearer(rt, '/api/nodes?parent=root', made.token)).status).toBe(401);
    expect((await bearer(rt, '/api/ops/reports', made.token)).status).toBe(404);
    const mint = await bearer(rt, '/api/tokens', made.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP },
      body: JSON.stringify({ name: 'x', scopes: ['drive.read'], expiresInDays: null }),
    });
    expect(mint.status).toBe(401);
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM api_tokens').get()).toEqual({ n: 1 });
  });

  it('checks scopes per route', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'token@zeiko.test');
    const reader = await make(user, { scopes: ['drive.read'] });
    const app = new Hono<AppBindings>();
    app.onError(onError);
    app.use('*', async (c, next) => {
      c.set('ctx', createCtx(c.env));
      await next();
    });
    app.use('*', tokenAuth);
    app.get('/read', scope('drive.read'), (c) => c.text('ok'));
    app.get('/write', scope('drive.write'), (c) => c.text('ok'));
    const call = (path: string) =>
      app.fetch(
        new Request(`${APP}${path}`, { headers: { authorization: `Bearer ${reader.token}` } }),
        rt.env,
      );
    expect((await call('/read')).status).toBe(200);
    const denied = await call('/write');
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('missing_scope');
  });

  it('stops working for frozen and deleted accounts, and is gone with the account', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'token@zeiko.test');
    const made = await make(user, { expiresInDays: null });
    rt.d1.sqlite.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).run(user.userId);
    expect((await bearer(rt, '/api/v1/me', made.token)).status).toBe(403);
    rt.d1.sqlite
      .prepare(`UPDATE users SET status = 'active', delete_requested_at = 1 WHERE id = ?`)
      .run(user.userId);
    expect(await processAccountDeletions(createCtx(rt.env))).toBe(1);
    expect(rt.d1.sqlite.prepare('SELECT COUNT(*) AS n FROM api_tokens').get()).toEqual({ n: 0 });
    expect((await bearer(rt, '/api/v1/me', made.token)).status).toBe(401);
  });

  it('limits requests per token', async () => {
    const rt = await makeRuntime({ rateLimits: { RL_API: { limit: 2, period: 60 } } });
    const user = await signIn(rt, 'token@zeiko.test');
    const made = await make(user);
    expect((await bearer(rt, '/api/v1/me', made.token)).status).toBe(200);
    expect((await bearer(rt, '/api/v1/me', made.token)).status).toBe(200);
    expect((await bearer(rt, '/api/v1/me', made.token)).status).toBe(429);
    // Another token of the same user has its own allowance.
    const other = await make(user, { name: 'lain' });
    expect((await bearer(rt, '/api/v1/me', other.token)).status).toBe(200);
  });
});
