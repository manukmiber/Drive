import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, schema } from '../../src/worker/db/client';
import { SESSION_COOKIE } from '../../src/worker/auth';
import { APP, makeRuntime } from '../helpers/runtime';
import { lastOtp, signIn } from '../helpers/session';

describe('auth (Better Auth on D1)', () => {
  it('signs up with email OTP and bootstraps the personal space', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'siti@example.com');
    expect(s.jar.get(SESSION_COOKIE)).toBeTruthy();

    const me = (await (await s.req('GET', '/api/me')).json()) as {
      user: { email: string; role: string };
      space: { poolId: string; personalRootId: string };
      storage: { limitBytes: number };
      subscription: unknown;
    };
    expect(me.user).toMatchObject({ email: 'siti@example.com', role: 'user' });
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
    const res = await rt.fetch(
      new Request(`${APP}/api/auth/email-otp/send-verification-otp`, {
        method: 'POST',
        headers: { origin: APP, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com', type: 'sign-in' }),
      }),
    );
    expect(res.status).toBe(200);
    const otp = await lastOtp(rt, 'a@example.com');
    const signed = await rt.fetch(
      new Request(`${APP}/api/auth/sign-in/email-otp`, {
        method: 'POST',
        headers: { origin: APP, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com', otp }),
      }),
    );
    const cookies = signed.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c).toMatch(/^__Host-/);
      expect(c).toMatch(/Secure/i);
      expect(c).toMatch(/Path=\//i);
      expect(c).not.toMatch(/Domain=/i);
    }
  });

  it('rejects a wrong OTP', async () => {
    const rt = await makeRuntime();
    await rt.fetch(
      new Request(`${APP}/api/auth/email-otp/send-verification-otp`, {
        method: 'POST',
        headers: { origin: APP, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'b@example.com', type: 'sign-in' }),
      }),
    );
    const res = await rt.fetch(
      new Request(`${APP}/api/auth/sign-in/email-otp`, {
        method: 'POST',
        headers: { origin: APP, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'b@example.com', otp: '000000' }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
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

  it('rate-limits OTP requests', async () => {
    const rt = await makeRuntime({ rateLimits: { RL_AUTH: { limit: 2, period: 60 } } });
    const send = () =>
      rt.fetch(
        new Request(`${APP}/api/auth/email-otp/send-verification-otp`, {
          method: 'POST',
          headers: { origin: APP, 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'd@example.com', type: 'sign-in' }),
        }),
      );
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });
});

describe('staff guard', () => {
  it('requires a second factor for admins', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'boss@example.com');
    const db = getDb(rt.env.DB);

    expect((await s.req('GET', '/api/admin/whoami')).status).toBe(403); // plain user

    await db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, s.userId));
    const no2fa = await s.req('GET', '/api/admin/whoami');
    expect(no2fa.status).toBe(403);
    expect(await no2fa.json()).toMatchObject({ error: { data: { reason: 'ADMIN_2FA_REQUIRED' } } });

    await db.insert(schema.passkeys).values({
      id: 'pk1',
      publicKey: 'x',
      userId: s.userId,
      credentialID: 'cred1',
      deviceType: 'singleDevice',
    });
    expect((await s.req('GET', '/api/admin/whoami')).status).toBe(200);
  });
});
