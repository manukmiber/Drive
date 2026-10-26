import type { Ctx } from './context';
import type { Env } from './env';

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
  };
};
