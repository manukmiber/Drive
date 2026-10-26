import { createOTP } from '@better-auth/utils/otp';
import { symmetricEncrypt } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { getDb, schema } from '../../src/worker/db/client';
import { SESSION_COOKIE } from '../../src/worker/auth';
import { MockZeikoAccounts } from '../../src/worker/adapters/zeiko';
import { APP, jsonReq, makeRuntime } from '../helpers/runtime';
import {
  exchange,
  Jar,
  proveSecondFactor,
  signIn,
  staffSignIn,
  zeikoAccountFor,
} from '../helpers/session';
import { addSoftPasskey } from '../helpers/webauthn';

describe('auth (Better Auth on D1)', () => {
  it('signs up with a Zeiko Account and bootstraps the personal space', async () => {
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

  it('offers no OTP, password or passkey sign-in', async () => {
    const rt = await makeRuntime();
    for (const path of [
      '/api/auth/email-otp/send-verification-otp',
      '/api/auth/sign-in/email',
      '/api/auth/passkey/generate-authenticate-options',
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

describe('staff guard (ADR-056)', () => {
  /** An admin whose account has TOTP, signed in through Zeiko Accounts only. */
  async function totpAdmin(rt: DevRuntime, email = 'boss@example.com') {
    const s = await signIn(rt, email);
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    rt.d1.sqlite
      .prepare("UPDATE users SET role = 'admin', two_factor_enabled = 1 WHERE id = ?")
      .run(s.userId);
    rt.d1.sqlite
      .prepare(
        'INSERT INTO two_factors (id, secret, backup_codes, user_id, verified) VALUES (?, ?, ?, ?, 1)',
      )
      .run(
        `tf_${s.userId}`,
        await symmetricEncrypt({ key: rt.env.BETTER_AUTH_SECRET, data: secret }),
        '[]',
        s.userId,
      );
    return { s, otp: createOTP(secret, { period: 30, digits: 6 }) };
  }

  const reason = async (res: Response) =>
    ((await res.json()) as { error?: { data?: { reason?: string } } }).error?.data?.reason;

  it('wants a factor on the account, then proved in this session', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'boss@example.com');
    const db = getDb(rt.env.DB);
    expect((await s.req('GET', '/api/admin/whoami')).status).toBe(403); // plain user

    await db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, s.userId));
    const no2fa = await s.req('GET', '/api/admin/whoami');
    expect(no2fa.status).toBe(403);
    expect(await reason(no2fa)).toBe('ADMIN_2FA_REQUIRED');

    const key = await addSoftPasskey(rt, s.userId);
    // Enrolled is not enough: signing in through Zeiko Accounts alone never opens staff routes.
    const notProved = await s.req('GET', '/api/admin/whoami');
    expect(notProved.status).toBe(403);
    expect(await reason(notProved)).toBe('SECOND_FACTOR_REQUIRED');

    const options = (await (
      await s.req('POST', '/api/auth/second-factor/passkey/options')
    ).json()) as {
      challenge: string;
      allowCredentials: Array<{ id: string }>;
    };
    expect(options.allowCredentials.map((c) => c.id)).toEqual([key.credentialId]);
    const verified = await s.req('POST', '/api/auth/second-factor/passkey/verify', {
      response: await key.assert(options.challenge, APP),
    });
    expect(verified.status).toBe(200);
    expect((await s.req('GET', '/api/admin/whoami')).status).toBe(200);
  });

  it('refuses a passkey assertion for another challenge or another user', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'boss@example.com');
    rt.d1.sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(s.userId);
    const mine = await addSoftPasskey(rt, s.userId);
    const other = await signIn(rt, 'lain@example.com');
    const theirs = await addSoftPasskey(rt, other.userId);
    const opts = async () =>
      (
        (await (await s.req('POST', '/api/auth/second-factor/passkey/options')).json()) as {
          challenge: string;
        }
      ).challenge;
    const stale = await s.req('POST', '/api/auth/second-factor/passkey/verify', {
      response: await mine.assert('AAAAAAAAAAAAAAAAAAAAAA', APP),
    });
    expect(stale.status).toBe(400); // no challenge issued yet
    const wrongKey = await s.req('POST', '/api/auth/second-factor/passkey/verify', {
      response: await theirs.assert(await opts(), APP),
    });
    expect(wrongKey.status).toBe(401);
    const wrongChallenge = await s.req('POST', '/api/auth/second-factor/passkey/verify', {
      response: await mine.assert(`${await opts()}x`, APP),
    });
    expect(wrongChallenge.status).toBe(401);
    expect((await s.req('GET', '/api/admin/whoami')).status).toBe(403);
  });

  it('accepts the authenticator code, locks after repeated wrong ones, and expires', async () => {
    const rt = await makeRuntime();
    const { s, otp } = await totpAdmin(rt);
    const send = (code: string) => s.req('POST', '/api/auth/second-factor/totp', { code });
    expect((await send('000000')).status).toBe(400);
    expect((await send(await otp.totp())).status).toBe(200);
    expect((await s.req('GET', '/api/admin/whoami')).status).toBe(200);

    // A proof older than staff_second_factor_hours (12) no longer opens the panel.
    rt.d1.sqlite
      .prepare('UPDATE sessions SET second_factor_at = ? WHERE user_id = ?')
      .run(Date.now() - 13 * 3600_000, s.userId);
    const old = await s.req('GET', '/api/admin/whoami');
    expect(await reason(old)).toBe('SECOND_FACTOR_REQUIRED');

    for (let i = 0; i < 5; i++) await send('111111');
    const locked = await send(await otp.totp());
    expect(locked.status).toBe(429);
  });

  it('a new sign-in starts without the proof', async () => {
    const rt = await makeRuntime();
    const { s, otp } = await totpAdmin(rt);
    await s.req('POST', '/api/auth/second-factor/totp', { code: await otp.totp() });
    expect((await s.req('GET', '/api/admin/whoami')).status).toBe(200);
    const again = await signIn(rt, 'boss@example.com');
    expect(await reason(await again.req('GET', '/api/admin/whoami'))).toBe(
      'SECOND_FACTOR_REQUIRED',
    );
  });

  it('changing a factor needs the proof once the account has one', async () => {
    const rt = await makeRuntime();
    const { s, otp } = await totpAdmin(rt);
    for (const [path, body] of [
      ['/api/auth/passkey/generate-register-options', undefined],
      ['/api/auth/two-factor/disable', {}],
      ['/api/auth/two-factor/enable', {}],
    ] as const) {
      const res = await s.req(path.includes('generate') ? 'GET' : 'POST', path, body);
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { code: string }).code, path).toBe('SECOND_FACTOR_REQUIRED');
    }
    await s.req('POST', '/api/auth/second-factor/totp', { code: await otp.totp() });
    const off = await s.req('POST', '/api/auth/two-factor/disable', {});
    expect(off.status).toBe(200);
    // A plain user with no factor yet sets up the first one freely.
    const u = await signIn(rt, 'baru@example.com');
    expect((await u.req('POST', '/api/auth/two-factor/enable', {})).status).toBe(200);
  });

  it('a suspended staff member keeps no staff access after signing in again', async () => {
    const rt = await makeRuntime();
    const adm = await staffSignIn(rt, 'kepala@example.com');
    const mod = await staffSignIn(rt, 'mod@example.com', 'moderator');
    const sus = await adm.req('POST', `/api/admin/users/${mod.userId}/suspend`, {
      suspended: true,
      reason: 'akun dicuri',
    });
    expect(sus.status).toBe(204);
    // Signs in through Zeiko Accounts again and even proves the second factor.
    const jar = new Jar();
    expect((await exchange(rt, jar, zeikoAccountFor('mod@example.com'))).status).toBe(200);
    proveSecondFactor(rt, mod.userId);
    const res = await rt.fetch(
      new Request(`${APP}/api/admin/reports?status=open`, { headers: { cookie: jar.header() } }),
    );
    expect(res.status).toBe(403);
    expect(await reason(res)).toBe('suspended');
  });

  it('only an admin can suspend a staff account', async () => {
    const rt = await makeRuntime();
    const adm = await staffSignIn(rt, 'kepala@example.com');
    const mod = await staffSignIn(rt, 'mod@example.com', 'moderator');
    const user = await signIn(rt, 'biasa@example.com');
    const tryIt = (who: typeof adm, id: string) =>
      who.req('POST', `/api/admin/users/${id}/suspend`, { suspended: true, reason: 'coba saja' });
    const refused = await tryIt(mod, adm.userId);
    expect(refused.status).toBe(403);
    expect(await reason(refused)).toBe('STAFF_TARGET');
    expect((await adm.req('GET', '/api/admin/whoami')).status).toBe(200);
    expect((await tryIt(mod, user.userId)).status).toBe(204);
  });
});
