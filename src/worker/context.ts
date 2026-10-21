// Per-request (or per-batch / per-cron) service context.
import type { AppConfig } from '../shared/config-defaults';
import { createAdapters, type Adapters } from './adapters';
import { systemClock, type Clock } from './adapters/clock';
import { getDb, type Db } from './db/client';
import type { Env } from './env';
import { getConfig } from './services/config';

export interface Ctx {
  env: Env;
  db: Db;
  clock: Clock;
  adapters: Adapters;
  config: () => Promise<AppConfig>;
  now: () => number;
}

export function createCtx(env: Env): Ctx {
  // Fake clocks are only honoured outside production.
  const clock = env.CLOCK && env.APP_ENV !== 'production' ? env.CLOCK : systemClock;
  let cfg: Promise<AppConfig> | null = null;
  return {
    env,
    db: getDb(env.DB),
    clock,
    adapters: createAdapters(env, clock),
    config: () => (cfg ??= getConfig(env, clock.now())),
    now: () => clock.now(),
  };
}
