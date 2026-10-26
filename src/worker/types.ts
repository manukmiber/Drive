import type { Ctx } from './context';
import type { Env } from './env';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'moderator' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
  twoFactorEnabled: boolean;
  /** When this session last proved TOTP or a passkey (ms), or null (ADR-056). */
  secondFactorAt: number | null;
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    ctx: Ctx;
    requestId: string;
    user: SessionUser | null;
  };
};
