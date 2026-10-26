import { passkeyClient } from '@better-auth/passkey/client';
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [emailOTPClient(), passkeyClient(), twoFactorClient()],
});

/** Better Auth's answer when a factor change needs this session's proof first (ADR-056). */
export function needsStepUp(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SECOND_FACTOR_REQUIRED';
}
