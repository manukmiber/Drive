import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, schema } from '../../src/worker/db/client';
import { SESSION_COOKIE } from '../../src/worker/auth';
import { MockZeikoAccounts } from '../../src/worker/adapters/zeiko';
import { APP, jsonReq, makeRuntime } from '../helpers/runtime';
import { exchange, Jar, signIn, zeikoAccountFor } from '../helpers/session';

describe('auth (Better Auth on D1)', () => {
  it('signs up with a Zeiko Account and bootstraps the personal space', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'siti@example.com');
    expect(s.jar.get(SESSION_COOKIE)).toBeTruthy();

    const me = (await (await s.req('GET', '/api/me')).json()) as {
      user: { email: string };
      space: { poolId: string; personalRootId: string };
      storage: { limitBytes: number };
      subscription: unknown;
    };
    expect(me.user).toMatchObject({ email: 'siti@example.com' });
    expect(me.user).not.toHaveProperty('role'); // no staff in Drive (ADR-057)
    expect(me.storage.limitBytes).toBe(0); // no free plan (SPEC §16 #9)
    expect(me.subscription).toBeNull();

    const db = getDb(rt.env.DB);
    const root = await db
      .select()
      .from(schema.nodes)
      .where(eq(schema.nodes.id, me.space.personalRootId))
      .get();
    expect(root).toMatchObject({
      parentId: null,
      space: 'personal',
      kind: 'folder',
      ownerId: s.userId,
    });
    const user = await db.select().from(schema.users).where(eq(schema.users.id, s.userId)).get();
    expect(user?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID ids
  });

  it('issues __Host- cookies only', async () => {
    const rt = await makeRuntime();
    const res = await exchange(rt, new Jar(), zeikoAccountFor('a@example.com'));
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c).toMatch(/^__Host-/);
      expect(c).toMatch(/Secure/i);
      expect(c).toMatch(/Path=\//i);
      expect(c).not.toMatch(/Domain=/i);
    }
  });

  it('opens a ticket once, and never for an unconfirmed email', async () => {
    const rt = await makeRuntime();
    const a = zeikoAccountFor('b@example.com');
    const ticket = await MockZeikoAccounts.issue(rt.env.CONFIG_KV, a);
    const post = (body: unknown) => rt.fetch(jsonReq('POST', '/api/auth/zeiko/exchange', body));
    expect((await post({ ticket })).status).toBe(200);
    const again = await post({ ticket });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: 'SIGN_IN_EXPIRED' });

    const unconfirmed = await exchange(
      rt,
      new Jar(),
      zeikoAccountFor('e@example.com', { emailVerified: false }),
    );
    expect(unconfirmed.status).toBe(403);
    expect(await unconfirmed.json()).toMatchObject({ code: 'EMAIL_UNVERIFIED' });
  });

  it('keeps one user per Zeiko Account and follows its email and name', async () => {
    const rt = await makeRuntime();
    const first = await signIn(rt, 'nina@example.com');
    const moved = zeikoAccountFor('nina@example.com', {
      email: 'nina@new.example',
      name: 'Nina K',
    });
    const again = await exchange(rt, new Jar(), moved, 'en');
    expect(again.status).toBe(200);
    const db = getDb(rt.env.DB);
    const users = await db.select().from(schema.users).all();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: first.userId, email: 'nina@new.example', name: 'Nina K' });
    // The language is only taken from the first sign-in.
    expect(users[0]!.locale).toBe('id');
  });

  it('links an existing user with the same confirmed email once', async () => {
    const rt = await makeRuntime();
    const old = await signIn(rt, 'lama@example.com');
    // A second Zeiko Account with that address (e.g. the first was deleted at the door).
    const other = zeikoAccountFor('lama@example.com', { id: 'zk_other' });
    expect((await exchange(rt, new Jar(), other)).status).toBe(200);
    const db = getDb(rt.env.DB);
    const links = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, old.userId))
      .all();
    expect(links.map((l) => l.accountId).sort()).toEqual(['zk_lama_example_com', 'zk_other']);
  });

  it('says which Zeiko Account the user signs in as', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'rina@example.com');
    const me = (await (await s.req('GET', '/api/me')).json()) as { user: { zeikoId: string } };
    expect(me.user.zeikoId).toBe('zk_rina_example_com');
  });

  it('ends the session a browser held when it signs in again (ADR-039)', async () => {
    const rt = await makeRuntime();
    const jar = new Jar();
    expect((await exchange(rt, jar, zeikoAccountFor('satu@example.com'))).status).toBe(200);
    const first = jar.get(SESSION_COOKIE);
    expect(first).toBeTruthy();
    // Signed in as somebody else at the door: the same browser trades its session in.
    expect((await exchange(rt, jar, zeikoAccountFor('dua@example.com'))).status).toBe(200);
    expect(jar.get(SESSION_COOKIE)).not.toBe(first);

    const db = getDb(rt.env.DB);
    const sessions = await db.select().from(schema.sessions).all();
    expect(sessions).toHaveLength(1);
    const me = (await (
      await rt.fetch(new Request(`${APP}/api/me`, { headers: { cookie: jar.header() } }))
    ).json()) as { user: { email: string; zeikoId: string } };
    expect(me.user).toMatchObject({ email: 'dua@example.com', zeikoId: 'zk_dua_example_com' });
    // The first person's cookie, kept elsewhere, opens nothing any more.
    const stale = await rt.fetch(
      new Request(`${APP}/api/me`, { headers: { cookie: `${SESSION_COOKIE}=${first}` } }),
    );
    expect(stale.status).toBe(401);
  });

  it('turns the mock door off outside dev', async () => {
    const rt = await makeRuntime({ vars: { APP_ENV: 'staging' } });
    const res = await exchange(rt, new Jar(), zeikoAccountFor('x@example.com'));
    expect(res.status).toBe(503);
  });

  it('offers no OTP, password, passkey or TOTP of its own', async () => {
    const rt = await makeRuntime();
    for (const path of [
      '/api/auth/email-otp/send-verification-otp',
      '/api/auth/sign-in/email',
      '/api/auth/passkey/generate-authenticate-options',
      '/api/auth/passkey/generate-register-options',
      '/api/auth/two-factor/enable',
      '/api/auth/second-factor/totp',
    ]) {
      const res = await rt.fetch(jsonReq('POST', path, { email: 'z@example.com' }));
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.status, path).not.toBe(500);
    }
  });

  it('requires a session for /api/me', async () => {
    const rt = await makeRuntime();
    const res = await rt.fetch(`${APP}/api/me`);
    expect(res.status).toBe(401);
  });

  it('requires the CSRF token on API mutations', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'c@example.com');
    const ok = await s.req('PATCH', '/api/me', { name: 'Budi' });
    expect(ok.status).toBe(200);
    const bad = await rt.fetch(
      new Request(`${APP}/api/me`, {
        method: 'PATCH',
        headers: { origin: APP, cookie: s.jar.header(), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X' }),
      }),
    );
    expect(bad.status).toBe(403);
    expect(await bad.json()).toMatchObject({ error: { code: 'CSRF' } });
  });

  it('rate-limits sign-in attempts', async () => {
    const rt = await makeRuntime({ rateLimits: { RL_AUTH: { limit: 2, period: 60 } } });
    const send = () =>
      rt.fetch(jsonReq('POST', '/api/auth/zeiko/exchange', { ticket: 'nope-nope-nope' }));
    expect((await send()).status).toBe(400);
    expect((await send()).status).toBe(400);
    expect((await send()).status).toBe(429);
  });
});
