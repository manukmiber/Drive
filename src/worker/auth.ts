// Better Auth on D1 via the Drizzle adapter. People sign in with Zeiko Accounts (ADR-036): the
// browser hands over a one-time ticket from the door, `/api/auth/zeiko/exchange` redeems it server
// to server and opens a session here. No passwords, OTP or Google of our own; passkeys and TOTP
// stay as the staff's second factor (SPEC §13.1). One instance per request, created lazily.
import { passkey } from '@better-auth/passkey';
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { twoFactor } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from './context';
import { schema } from './db/client';
import { ulid } from './lib/ids';
import { isAppError } from './lib/errors';
import { log } from './lib/log';
import { ensurePersonalSpace } from './services/accounts';

export const AUTH_BASE_PATH = '/api/auth';
/** `__Host-` cookies: Secure, Path=/, no Domain → never sent to USERCONTENT_ORIGIN (SPEC §14.4). */
export const COOKIE_PREFIX = '__Host-zk';
export const SESSION_COOKIE = `${COOKIE_PREFIX}.session_token`;
/** `accounts.provider_id` of a Zeiko Account link; `account_id` is the Zeiko id. */
export const ZEIKO_PROVIDER = 'zeiko';

/** Sign-in paths that would bypass Zeiko Accounts: a passkey is a second factor only. */
const DISABLED_PATHS = ['/passkey/generate-authenticate-options', '/passkey/verify-authentication'];

const STATUS = { 400: 'BAD_REQUEST', 403: 'FORBIDDEN', 503: 'SERVICE_UNAVAILABLE' } as const;

/** An AppError in Better Auth's own error shape, keeping our code for the client. */
function asApiError(e: unknown): unknown {
  if (!isAppError(e)) return e;
  const status = STATUS[e.status as keyof typeof STATUS] ?? 'BAD_REQUEST';
  return new APIError(status, { code: e.code, message: e.message });
}

/**
 * `POST /api/auth/zeiko/exchange {ticket, locale?}`: the visitor's browser got `ticket` from the
 * door (it holds the door's session); we redeem it, find or make the user, and sign them in.
 * A Zeiko Account is linked by its id; an older user with the same, confirmed, address is linked
 * on their first sign-in. An unconfirmed address never links and never signs in — whoever typed
 * it at the door may not own it, and Drive mails it.
 */
function zeikoSignIn(ctx: Ctx): BetterAuthPlugin {
  return {
    id: 'zeiko-accounts',
    endpoints: {
      zeikoExchange: createAuthEndpoint(
        '/zeiko/exchange',
        {
          method: 'POST',
          body: z.object({
            ticket: z.string().min(8).max(128),
            locale: z.enum(['id', 'en']).optional(),
          }),
        },
        async (c) => {
          const { env, adapters, db } = ctx;
          if (adapters.accounts.name === 'mock' && env.APP_ENV !== 'dev') {
            throw new APIError('SERVICE_UNAVAILABLE', {
              code: 'ACCOUNTS_UNAVAILABLE',
              message: 'Zeiko Accounts is not connected',
            });
          }
          let a;
          try {
            a = await adapters.accounts.redeemTicket(c.body.ticket);
          } catch (e) {
            throw asApiError(e);
          }
          const email = a.email.trim().toLowerCase();
          if (!email || !a.emailVerified) {
            throw new APIError('FORBIDDEN', {
              code: 'EMAIL_UNVERIFIED',
              message: 'Confirm your email on your Zeiko Account first',
            });
          }
          const name = (a.name || a.username).slice(0, 80);
          const ia = c.context.internalAdapter;
          const link = await db
            .select({ userId: schema.accounts.userId })
            .from(schema.accounts)
            .where(
              and(
                eq(schema.accounts.providerId, ZEIKO_PROVIDER),
                eq(schema.accounts.accountId, a.id),
              ),
            )
            .get();
          let userId = link?.userId;
          if (!userId) {
            const same = await db
              .select({ id: schema.users.id })
              .from(schema.users)
              .where(eq(schema.users.email, email))
              .get();
            if (same) {
              await ia.createAccount({ userId: same.id, providerId: ZEIKO_PROVIDER, accountId: a.id });
              userId = same.id;
              log.info('zeiko_linked', { userId });
            } else {
              const made = await ia.createOAuthUser(
                { email, name, emailVerified: true, image: null },
                { providerId: ZEIKO_PROVIDER, accountId: a.id },
              );
              userId = made.user.id;
              await ensurePersonalSpace(ctx, userId);
              if (c.body.locale) {
                await env.DB.prepare('UPDATE users SET locale = ?2 WHERE id = ?1')
                  .bind(userId, c.body.locale)
                  .run();
              }
            }
          }
          // The door is where an address or a name changes; follow it. An address another user
          // here still holds stays as it was until they change theirs.
          await env.DB.prepare(
            `UPDATE users SET email = ?2, name = CASE WHEN ?3 = '' THEN name ELSE ?3 END, email_verified = 1, updated_at = ?4
             WHERE id = ?1 AND (email != ?2 OR name != ?3)
               AND NOT EXISTS (SELECT 1 FROM users o WHERE o.email = ?2 AND o.id != ?1)`,
          )
            .bind(userId, email, name, ctx.now())
            .run();
          const user = await ia.findUserById(userId);
          if (!user) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'user vanished' });
          // A session this browser still holds (the person before, or this one from an earlier
          // sign-in) ends here: one browser, one session (ADR-039).
          const held = await getSessionFromCtx(c, { disableRefresh: true }).catch(() => null);
          if (held) await ia.deleteSession(held.session.token);
          const session = await ia.createSession(userId);
          await setSessionCookie(c, { session, user });
          return c.json({ ok: true });
        },
      ),
    },
  };
}

function build(ctx: Ctx) {
  const { env } = ctx;
  return betterAuth({
    appName: 'Zeiko Drive',
    baseURL: env.APP_ORIGIN,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_ORIGIN],
    disabledPaths: DISABLED_PATHS,
    database: drizzleAdapter(ctx.db, {
      provider: 'sqlite',
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verifications: schema.verifications,
        passkeys: schema.passkeys,
        twoFactors: schema.twoFactors,
      },
    }),
    user: {
      modelName: 'users',
      additionalFields: {
        role: { type: 'string', input: false, defaultValue: 'user' },
        status: { type: 'string', input: false, defaultValue: 'active' },
        adCityCode: { type: 'string', required: false, input: false },
        locale: { type: 'string', required: false, input: false, defaultValue: 'id' },
      },
    },
    session: {
      modelName: 'sessions',
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    account: { modelName: 'accounts', accountLinking: { enabled: false } },
    verification: { modelName: 'verifications' },
    emailAndPassword: { enabled: false },
    // Our own Rate Limiting binding guards /api/auth (ADR-004); Better Auth's limiter would need
    // a shared store.
    rateLimit: { enabled: false },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: false, // the __Host- prefix is part of the name; Secure is set below
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
      database: { generateId: () => ulid(ctx.now()) },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await ensurePersonalSpace(ctx, user.id);
            log.info('user_created', { userId: user.id });
          },
        },
      },
    },
    plugins: [
      zeikoSignIn(ctx),
      passkey({
        rpID: new URL(env.APP_ORIGIN).hostname,
        rpName: 'Zeiko Drive',
        origin: env.APP_ORIGIN,
        schema: { passkey: { modelName: 'passkeys' } },
      }),
      twoFactor({
        issuer: 'Zeiko Drive',
        // Accounts have no password here (Zeiko Accounts holds it), so TOTP is managed with the
        // session alone.
        allowPasswordless: true,
        schema: { twoFactor: { modelName: 'twoFactors' } },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof build>;

export function getAuth(ctx: Ctx): Auth {
  // Better Auth keeps per-instance state only for config, so one instance per request is cheap
  // enough and keeps the injected clock/adapters consistent.
  return build(ctx);
}
