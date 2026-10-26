// Sign-in for Zeiko's own apps (ADR-063): authorization code + PKCE, refresh rotation with reuse
// detection, revocation, and the connected-apps list in Settings.
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

const b64url = (b: Buffer) => b.toString('base64url');

function pkce() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

const CLI_REDIRECT = 'http://127.0.0.1:53682/callback';

function authorizeQuery(over: Record<string, string> = {}, challenge = pkce().challenge) {
  return {
    client_id: 'zeiko-cli',
    redirect_uri: CLI_REDIRECT,
    scope: 'drive.read share',
    state: 'st-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...over,
  };
}

async function getCode(user: Session, q: Record<string, string>): Promise<string> {
  const res = await user.req('POST', '/api/oauth/authorize', { ...q, approve: true });
  expect(res.status).toBe(200);
  const url = new URL(((await res.json()) as { redirect: string }).redirect);
  expect(url.origin + url.pathname).toBe(q.redirect_uri);
  expect(url.searchParams.get('state')).toBe(q.state);
  return url.searchParams.get('code')!;
}

function token(rt: DevRuntime, form: Record<string, string>) {
  return rt.fetch(
    new Request(`${APP}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }),
  );
}

const bearer = (rt: DevRuntime, path: string, t: string) =>
  rt.fetch(new Request(`${APP}/api/v1${path}`, { headers: { authorization: `Bearer ${t}` } }));

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

async function connect(rt: DevRuntime, user: Session, scope = 'drive.read share') {
  const p = pkce();
  const q = authorizeQuery({ scope }, p.challenge);
  const code = await getCode(user, q);
  const res = await token(rt, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: CLI_REDIRECT,
    client_id: 'zeiko-cli',
    code_verifier: p.verifier,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toContain('no-store');
  return (await res.json()) as Tokens;
}

describe('OAuth for Zeiko apps (ADR-063)', () => {
  it('signs an app in with PKCE, limited to the approved scopes', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'app@zeiko.test');
    const shown = await user.req(
      'GET',
      `/api/oauth/authorize?${new URLSearchParams(authorizeQuery())}`,
    );
    expect(shown.status).toBe(200);
    expect(await shown.json()).toMatchObject({
      client: { id: 'zeiko-cli', name: 'Zeiko CLI' },
      scopes: ['drive.read', 'share'],
    });
    const t = await connect(rt, user);
    expect(t.token_type).toBe('Bearer');
    expect(t.access_token).toMatch(/^zkd_/);
    expect(t.refresh_token).toMatch(/^zkr_/);
    expect(t.scope).toBe('drive.read share');
    const me = await bearer(rt, '/me', t.access_token);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { token: { scopes: string[] } }).token.scopes).toEqual([
      'drive.read',
      'share',
    ]);
    // Not approved: s3.manage.
    expect((await bearer(rt, '/s3', t.access_token)).status).toBe(403);
    // A refresh token is never a Bearer token.
    expect((await bearer(rt, '/me', t.refresh_token)).status).toBe(401);
    // Not a personal token either: the Settings list stays empty, the apps list has it.
    expect(
      ((await (await user.req('GET', '/api/tokens')).json()) as { tokens: unknown[] }).tokens,
    ).toEqual([]);
    const apps = (await (await user.req('GET', '/api/tokens/apps')).json()) as {
      apps: Array<{ clientId: string; scopes: string[] }>;
    };
    expect(apps.apps).toMatchObject([{ clientId: 'zeiko-cli', scopes: ['drive.read', 'share'] }]);
  });

  it('refuses unknown apps, unregistered redirects, missing PKCE and foreign scopes on the page', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'app@zeiko.test');
    const bad: Array<[Record<string, string>, string]> = [
      [{ client_id: 'someone-else' }, 'invalid_client'],
      [{ redirect_uri: 'https://evil.example/callback' }, 'invalid_redirect_uri'],
      [{ redirect_uri: 'http://127.0.0.1:53682/other' }, 'invalid_redirect_uri'],
      [{ redirect_uri: 'http://localhost:53682/callback' }, 'invalid_redirect_uri'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ state: '' }, 'invalid_request'],
      [{ scope: 'drive.read admin' }, 'invalid_scope'],
    ];
    for (const [over, reason] of bad) {
      const q = new URLSearchParams(authorizeQuery(over));
      const res = await user.req('GET', `/api/oauth/authorize?${q}`);
      expect(res.status, reason).toBe(400);
      expect(await res.text()).toContain(reason);
      const post = await user.req('POST', '/api/oauth/authorize', {
        ...authorizeQuery(over),
        approve: true,
      });
      expect(post.status, reason).toBe(400);
    }
    // Android: App Links and its own scheme; the loopback is not one of its addresses.
    const android = authorizeQuery({
      client_id: 'zeiko-android',
      redirect_uri: `${APP}/app/callback`,
    });
    expect(
      (await user.req('GET', `/api/oauth/authorize?${new URLSearchParams(android)}`)).status,
    ).toBe(200);
    expect(
      (
        await user.req(
          'GET',
          `/api/oauth/authorize?${new URLSearchParams(authorizeQuery({ client_id: 'zeiko-android' }))}`,
        )
      ).status,
    ).toBe(400);
    // Denying sends the app access_denied.
    const no = await user.req('POST', '/api/oauth/authorize', {
      ...authorizeQuery(),
      approve: false,
    });
    const url = new URL(((await no.json()) as { redirect: string }).redirect);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('st-123');
    // Not signed in: no approval at all.
    const anon = await rt.fetch(
      new Request(`${APP}/api/oauth/authorize?${new URLSearchParams(authorizeQuery())}`),
    );
    expect(anon.status).toBe(401);
  });

  it('takes a code once, with the right verifier, redirect and client, before it expires', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'app@zeiko.test');
    const p = pkce();
    const q = authorizeQuery({}, p.challenge);
    const base = {
      grant_type: 'authorization_code',
      redirect_uri: CLI_REDIRECT,
      client_id: 'zeiko-cli',
    };

    const c1 = await getCode(user, q);
    const wrongVerifier = await token(rt, { ...base, code: c1, code_verifier: pkce().verifier });
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toMatchObject({ error: 'invalid_grant' });

    const c2 = await getCode(user, q);
    expect(
      (
        await token(rt, {
          ...base,
          code: c2,
          code_verifier: p.verifier,
          redirect_uri: 'http://127.0.0.1:1/callback',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await token(rt, {
          ...base,
          code: c2,
          code_verifier: p.verifier,
          client_id: 'zeiko-desktop',
        })
      ).status,
    ).toBe(400);

    const c3 = await getCode(user, q);
    rt.d1.sqlite.prepare('UPDATE oauth_codes SET expires_at = 1').run();
    expect((await token(rt, { ...base, code: c3, code_verifier: p.verifier })).status).toBe(400);

    // Used twice: the second fails and what the first made is revoked.
    const c4 = await getCode(user, q);
    const first = await token(rt, { ...base, code: c4, code_verifier: p.verifier });
    expect(first.status).toBe(200);
    const t = (await first.json()) as Tokens;
    expect((await bearer(rt, '/me', t.access_token)).status).toBe(200);
    const second = await token(rt, { ...base, code: c4, code_verifier: p.verifier });
    expect(second.status).toBe(400);
    expect((await bearer(rt, '/me', t.access_token)).status).toBe(401);

    expect((await token(rt, { grant_type: 'password', client_id: 'zeiko-cli' })).status).toBe(400);
    const json = await rt.fetch(
      new Request(`${APP}/api/v1/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'nope',
          code: 'x',
          redirect_uri: CLI_REDIRECT,
          code_verifier: p.verifier,
        }),
      }),
    );
    expect(json.status).toBe(401);
    expect(await json.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('rotates refresh tokens and ends the connection when an old one comes back', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'app@zeiko.test');
    const t1 = await connect(rt, user);
    const r = (rt2: Tokens) =>
      token(rt, {
        grant_type: 'refresh_token',
        refresh_token: rt2.refresh_token,
        client_id: 'zeiko-cli',
      });
    const res2 = await r(t1);
    expect(res2.status).toBe(200);
    const t2 = (await res2.json()) as Tokens;
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await bearer(rt, '/me', t2.access_token)).status).toBe(200);
    // Another client cannot use it.
    expect(
      (
        await token(rt, {
          grant_type: 'refresh_token',
          refresh_token: t2.refresh_token,
          client_id: 'zeiko-desktop',
        })
      ).status,
    ).toBe(400);
    // t1's refresh token again: someone copied it. Everything of this connection stops.
    expect((await r(t1)).status).toBe(400);
    expect((await bearer(rt, '/me', t2.access_token)).status).toBe(401);
    expect((await r(t2)).status).toBe(400);
    expect(
      ((await (await user.req('GET', '/api/tokens/apps')).json()) as { apps: unknown[] }).apps,
    ).toEqual([]);
  });

  it('signs out through /oauth/revoke and from Settings', async () => {
    const rt = await makeRuntime();
    const user = await signIn(rt, 'app@zeiko.test');
    const revoke = (t: string) =>
      rt.fetch(
        new Request(`${APP}/api/v1/oauth/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: t, client_id: 'zeiko-cli' }).toString(),
        }),
      );
    const a = await connect(rt, user);
    expect((await revoke(a.access_token)).status).toBe(200);
    expect((await bearer(rt, '/me', a.access_token)).status).toBe(401);
    // The refresh token still works after only the access token was revoked.
    const again = await token(rt, {
      grant_type: 'refresh_token',
      refresh_token: a.refresh_token,
      client_id: 'zeiko-cli',
    });
    expect(again.status).toBe(200);
    const a2 = (await again.json()) as Tokens;
    expect((await revoke(a2.refresh_token)).status).toBe(200);
    expect((await bearer(rt, '/me', a2.access_token)).status).toBe(401);
    expect((await revoke('zkd_unknown')).status).toBe(200);

    const b = await connect(rt, user);
    const apps = (await (await user.req('GET', '/api/tokens/apps')).json()) as {
      apps: Array<{ id: string }>;
    };
    expect(apps.apps).toHaveLength(1);
    expect((await user.req('DELETE', `/api/tokens/apps/${apps.apps[0]!.id}`)).status).toBe(204);
    expect((await bearer(rt, '/me', b.access_token)).status).toBe(401);
    expect(
      (
        await token(rt, {
          grant_type: 'refresh_token',
          refresh_token: b.refresh_token,
          client_id: 'zeiko-cli',
        })
      ).status,
    ).toBe(400);
    // Someone else's connection is not theirs to end.
    const other = await signIn(rt, 'lain@zeiko.test');
    const c = await connect(rt, user);
    const mine = (await (await user.req('GET', '/api/tokens/apps')).json()) as {
      apps: Array<{ id: string }>;
    };
    expect((await other.req('DELETE', `/api/tokens/apps/${mine.apps[0]!.id}`)).status).toBe(404);
    expect((await bearer(rt, '/me', c.access_token)).status).toBe(200);
  });

  it('publishes assetlinks.json only once the Android app is known', async () => {
    const none = await makeRuntime();
    expect((await none.fetch(new Request(`${APP}/.well-known/assetlinks.json`))).status).toBe(404);
    const fp = Array.from({ length: 32 }, (_, i) => (i * 7).toString(16).padStart(2, '0')).join(
      ':',
    );
    const rt = await makeRuntime({
      vars: { ANDROID_APP_PACKAGE: 'id.biz.zeiko.drive', ANDROID_CERT_SHA256: fp },
    });
    const res = await rt.fetch(new Request(`${APP}/.well-known/assetlinks.json`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'id.biz.zeiko.drive',
          sha256_cert_fingerprints: [fp.toUpperCase()],
        },
      },
    ]);
  });
});
