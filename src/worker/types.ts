import type { Ctx } from './context';
import type { Env } from './env';
import type { TokenAuth } from './services/tokens';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    ctx: Ctx;
    requestId: string;
    user: SessionUser | null;
    /** Set on /api/v1 (ADR-061): the access token the request signed in with. */
    token?: TokenAuth;
  };
};
