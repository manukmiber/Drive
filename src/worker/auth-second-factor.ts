// A second factor this session has proved (ADR-056). Signing in through Zeiko Accounts is one
// factor; staff routes also want a TOTP code or a passkey from this session, recently
// (`staff_second_factor_hours`). The proof is a timestamp on the session row.
//
// Adding or removing a factor needs that proof too once the account has one, so whoever holds only
// the Zeiko Accounts sign-in cannot swap in a factor of their own.
import { base64 } from '@better-auth/utils/base64';
import { createOTP } from '@better-auth/utils/otp';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import type { BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
  sessionMiddleware,
} from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { and, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from './context';
import { schema } from './db/client';
import { log } from './lib/log';
import { enforceRateLimit } from './middleware/ratelimit';

/** Wrong TOTP codes in a row before the factor rests for LOCK_MS. */
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
/** How long a passkey challenge waits for its answer. */
const CHALLENGE_MS = 5 * 60_000;

/** Better Auth's routes that add, show or remove a factor. */
const FACTOR_PATHS = new Set([
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
  '/two-factor/view-backup-codes',
]);
/** Of those, the ones whose success changes the account's factors (worth an alert for staff). */
const CHANGED_PATHS = new Set([
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
  '/two-factor/verify-totp',
  '/two-factor/disable',
]);

/** Whether `at` (ms, or a Date from the session row) is a proof still fresh enough. */
export function secondFactorFresh(
  at: number | Date | null | undefined,
  hours: number,
  now: number,
): boolean {
  if (at == null) return false;
  const ms = typeof at === 'number' ? at : at.getTime();
  return ms <= now && now - ms < hours * 3600_000;
}

/** TOTP enabled, or at least one passkey. */
export async function hasSecondFactor(
  ctx: Ctx,
  user: { id: string; twoFactorEnabled?: boolean | null | undefined },
): Promise<boolean> {
  if (user.twoFactorEnabled) return true;
  const row = await ctx.db
    .select({ n: count() })
    .from(schema.passkeys)
    .where(eq(schema.passkeys.userId, user.id))
    .get();
  return (row?.n ?? 0) > 0;
}

function required(): APIError {
  return new APIError('FORBIDDEN', {
    code: 'SECOND_FACTOR_REQUIRED',
    message: 'Confirm with your passkey or authenticator code first',
  });
}

export function secondFactor(ctx: Ctx): BetterAuthPlugin {
  const { env, db } = ctx;
  const rpID = new URL(env.APP_ORIGIN).hostname;
  const challengeId = (sessionId: string) => `2fa-step-${sessionId}`;

  async function proved(sessionToken: string): Promise<number> {
    const now = ctx.now();
    await db
      .update(schema.sessions)
      .set({ secondFactorAt: new Date(now) })
      .where(eq(schema.sessions.token, sessionToken))
      .run();
    return now + (await ctx.config()).staff_second_factor_hours * 3600_000;
  }

  async function limit(userId: string): Promise<void> {
    try {
      await enforceRateLimit(env, 'RL_AUTH', `2fa:${userId}`);
    } catch {
      throw new APIError('TOO_MANY_REQUESTS', {
        code: 'RATE_LIMITED',
        message: 'too many requests',
      });
    }
  }

  return {
    id: 'zeiko-second-factor',
    endpoints: {
      secondFactorTotp: createAuthEndpoint(
        '/second-factor/totp',
        {
          method: 'POST',
          body: z.object({ code: z.string().regex(/^\d{6}$/) }),
          use: [sessionMiddleware],
        },
        async (c) => {
          const { session, user } = c.context.session;
          await limit(user.id);
          const row = await db
            .select()
            .from(schema.twoFactors)
            .where(and(eq(schema.twoFactors.userId, user.id), eq(schema.twoFactors.verified, true)))
            .get();
          if (!row || !user.twoFactorEnabled)
            throw new APIError('BAD_REQUEST', { code: 'TOTP_NOT_ENABLED', message: 'no TOTP' });
          const now = ctx.now();
          if (row.lockedUntil && row.lockedUntil.getTime() > now)
            throw new APIError('TOO_MANY_REQUESTS', {
              code: 'SECOND_FACTOR_LOCKED',
              message: 'Too many wrong codes. Try again in a few minutes.',
            });
          const secret = await symmetricDecrypt({ key: c.context.secretConfig, data: row.secret });
          const ok = await createOTP(secret, { period: 30, digits: 6 }).verify(c.body.code);
          if (!ok) {
            const failures = row.failedVerificationCount + 1;
            const lock = failures >= MAX_FAILURES;
            await db
              .update(schema.twoFactors)
              .set({
                failedVerificationCount: lock ? 0 : failures,
                lockedUntil: lock ? new Date(now + LOCK_MS) : row.lockedUntil,
              })
              .where(eq(schema.twoFactors.id, row.id))
              .run();
            log.warn('second_factor_failed', { userId: user.id, method: 'totp' });
            throw new APIError('BAD_REQUEST', { code: 'INVALID_CODE', message: 'wrong code' });
          }
          if (row.failedVerificationCount > 0)
            await db
              .update(schema.twoFactors)
              .set({ failedVerificationCount: 0 })
              .where(eq(schema.twoFactors.id, row.id))
              .run();
          const until = await proved(session.token);
          log.info('second_factor_ok', { userId: user.id, method: 'totp' });
          return c.json({ ok: true, until });
        },
      ),
      secondFactorPasskeyOptions: createAuthEndpoint(
        '/second-factor/passkey/options',
        { method: 'POST', use: [sessionMiddleware] },
        async (c) => {
          const { session, user } = c.context.session;
          await limit(user.id);
          const keys = await db
            .select({ id: schema.passkeys.credentialID, transports: schema.passkeys.transports })
            .from(schema.passkeys)
            .where(eq(schema.passkeys.userId, user.id))
            .all();
          if (!keys.length)
            throw new APIError('BAD_REQUEST', { code: 'NO_PASSKEY', message: 'no passkey' });
          const options = await generateAuthenticationOptions({
            rpID,
            userVerification: 'preferred',
            allowCredentials: keys.map((k) => ({
              id: k.id,
              ...(k.transports
                ? {
                    transports: k.transports
                      .split(',')
                      .filter(Boolean) as AuthenticatorTransportFuture[],
                  }
                : {}),
            })),
          });
          const ia = c.context.internalAdapter;
          await ia.deleteVerificationByIdentifier(challengeId(session.id));
          await ia.createVerificationValue({
            identifier: challengeId(session.id),
            value: options.challenge,
            expiresAt: new Date(ctx.now() + CHALLENGE_MS),
          });
          return c.json(options);
        },
      ),
      secondFactorPasskeyVerify: createAuthEndpoint(
        '/second-factor/passkey/verify',
        {
          method: 'POST',
          body: z.object({ response: z.record(z.string(), z.unknown()) }),
          use: [sessionMiddleware],
        },
        async (c) => {
          const { session, user } = c.context.session;
          await limit(user.id);
          const ia = c.context.internalAdapter;
          const challenge = await ia.findVerificationValue(challengeId(session.id));
          await ia.deleteVerificationByIdentifier(challengeId(session.id));
          if (!challenge || challenge.expiresAt.getTime() < ctx.now())
            throw new APIError('BAD_REQUEST', {
              code: 'CHALLENGE_NOT_FOUND',
              message: 'Start again',
            });
          const response = c.body.response as unknown as AuthenticationResponseJSON;
          const key = await db
            .select()
            .from(schema.passkeys)
            .where(
              and(
                eq(schema.passkeys.userId, user.id),
                eq(schema.passkeys.credentialID, String(response.id)),
              ),
            )
            .get();
          if (!key)
            throw new APIError('UNAUTHORIZED', {
              code: 'PASSKEY_NOT_FOUND',
              message: 'no passkey',
            });
          let verified = false;
          let newCounter = key.counter;
          try {
            const v = await verifyAuthenticationResponse({
              response,
              expectedChallenge: challenge.value,
              expectedOrigin: env.APP_ORIGIN,
              expectedRPID: rpID,
              credential: {
                id: key.credentialID,
                publicKey: base64.decode(key.publicKey),
                counter: key.counter,
                ...(key.transports
                  ? {
                      transports: key.transports
                        .split(',')
                        .filter(Boolean) as AuthenticatorTransportFuture[],
                    }
                  : {}),
              },
              requireUserVerification: false,
            });
            verified = v.verified;
            newCounter = v.authenticationInfo.newCounter;
          } catch (e) {
            log.warn('second_factor_failed', {
              userId: user.id,
              method: 'passkey',
              error: String(e).slice(0, 200),
            });
          }
          if (!verified)
            throw new APIError('UNAUTHORIZED', {
              code: 'AUTHENTICATION_FAILED',
              message: 'That passkey did not confirm',
            });
          await db
            .update(schema.passkeys)
            .set({ counter: newCounter })
            .where(eq(schema.passkeys.id, key.id))
            .run();
          const until = await proved(session.token);
          log.info('second_factor_ok', { userId: user.id, method: 'passkey' });
          return c.json({ ok: true, until });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (c) => FACTOR_PATHS.has(c.path ?? ''),
          handler: createAuthMiddleware(async (c) => {
            const s = await getSessionFromCtx(c);
            if (!s) return; // the route itself answers 401
            if (!(await hasSecondFactor(ctx, s.user))) return; // the first factor: nothing to prove yet
            const hours = (await ctx.config()).staff_second_factor_hours;
            const at = (s.session as { secondFactorAt?: Date | null }).secondFactorAt;
            if (!secondFactorFresh(at, hours, ctx.now())) throw required();
          }),
        },
      ],
      after: [
        {
          matcher: (c) => CHANGED_PATHS.has(c.path ?? ''),
          handler: createAuthMiddleware(async (c) => {
            if (isAPIError(c.context.returned)) return;
            const s = c.context.session ?? c.context.newSession;
            const user = s?.user as { id: string; role?: string } | undefined;
            if (!user) return;
            log.info('second_factor_changed', { userId: user.id, path: c.path });
            if (user.role === 'admin' || user.role === 'moderator')
              await env.NOTIFY_QUEUE.send({
                type: 'admin_alert',
                text: `Faktor kedua akun staf ${user.id} berubah (${c.path}). Kalau bukan pemiliknya, bekukan akun itu.`,
              });
          }),
        },
      ],
    },
  };
}
