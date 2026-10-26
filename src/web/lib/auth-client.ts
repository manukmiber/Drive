import { createAuthClient } from 'better-auth/react';

/** Sessions only: signing in is Zeiko Accounts' (ADR-036), and Drive has no second factor (ADR-057). */
export const authClient = createAuthClient({ basePath: '/api/auth' });
