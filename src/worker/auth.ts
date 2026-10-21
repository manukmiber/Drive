// Better Auth on D1 via the Drizzle adapter (SPEC §2: no passwords; Google OAuth, email OTP,
// passkey; TOTP for admins). One instance per env, created lazily.
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { captcha, emailOTP, twoFactor } from 'better-auth/plugins';
import type { Ctx } from './context';
import { schema } from './db/client';
import { ulid } from './lib/ids';
import { log } from './lib/log';
import { ensurePersonalSpace } from './services/accounts';
import { otpEmail } from './services/email-templates';

export const AUTH_BASE_PATH = '/api/auth';
/** `__Host-` cookies: Secure, Path=/, no Domain → never sent to USERCONTENT_ORIGIN (SPEC §14.4). */
export const COOKIE_PREFIX = '__Host-zk';
export const SESSION_COOKIE = `${COOKIE_PREFIX}.session_token`;

function build(ctx: Ctx) {
  const { env } = ctx;
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            prompt: 'select_account' as const,
          },
        }
      : {};
  return betterAuth({
    appName: 'Zeiko',
    baseURL: env.APP_ORIGIN,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_ORIGIN],
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
      },
    },
    session: {
      modelName: 'sessions',
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    account: {
      modelName: 'accounts',
      accountLinking: { enabled: true, trustedProviders: ['google', 'email-otp'] },
    },
    verification: { modelName: 'verifications' },
    emailAndPassword: { enabled: false },
    socialProviders: google,
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
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        async sendVerificationOTP({ email, otp, type }) {
          await ctx.adapters.email.send({ to: [email], tag: `otp:${type}`, ...otpEmail(otp) });
        },
      }),
      passkey({
        rpID: new URL(env.APP_ORIGIN).hostname,
        rpName: 'Zeiko',
        origin: env.APP_ORIGIN,
        schema: { passkey: { modelName: 'passkeys' } },
      }),
      twoFactor({
        issuer: 'Zeiko',
        // Accounts are passwordless (SPEC §2), so TOTP is managed with the session alone.
        allowPasswordless: true,
        schema: { twoFactor: { modelName: 'twoFactors' } },
      }),
      ...(env.TURNSTILE_SECRET_KEY
        ? [
            captcha({
              provider: 'cloudflare-turnstile',
              secretKey: env.TURNSTILE_SECRET_KEY,
              endpoints: ['/email-otp/send-verification-otp'],
            }),
          ]
        : []),
    ],
  });
}

export type Auth = ReturnType<typeof build>;

export function getAuth(ctx: Ctx): Auth {
  // Better Auth keeps per-instance state only for config, so one instance per request is cheap
  // enough and keeps the injected clock/adapters consistent.
  return build(ctx);
}
