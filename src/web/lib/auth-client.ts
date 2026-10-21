import { passkeyClient } from '@better-auth/passkey/client';
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [emailOTPClient(), passkeyClient(), twoFactorClient()],
});
