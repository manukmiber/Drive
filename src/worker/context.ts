// Per-request (or per-batch / per-cron) service context.
import type { AppConfig } from '../shared/config-defaults';
import { createAdapters, type Adapters } from './adapters';
import { systemClock, type Clock } from './adapters/clock';
import { getDb, type Db } from './db/client';
import type { Env } from './env';
import { log } from './lib/log';
import { getConfig } from './services/config';

export interface Ctx {
  env: Env;
  db: Db;
  clock: Clock;
  adapters: Adapters;
  config: () => Promise<AppConfig>;
  now: () => number;
  /**
   * Work that may finish after the response (the request's waitUntil). Without an execution context
   * (queue batches, cron, tests) it is kept until drain().
   */
  defer: (work: Promise<unknown>) => void;
  /** Waits for deferred work that has no execution context to carry it. */
  drain: () => Promise<void>;
}

export function createCtx(env: Env, waitUntil?: (p: Promise<unknown>) => void): Ctx {
  // Fake clocks are only honoured outside production.
  const clock = env.CLOCK && env.APP_ENV !== 'production' ? env.CLOCK : systemClock;
  let cfg: Promise<AppConfig> | null = null;
  const held: Promise<unknown>[] = [];
  const quiet = (p: Promise<unknown>) =>
    p.catch((e: unknown) => log.error('deferred_failed', { message: String(e) }));
  return {
    env,
    db: getDb(env.DB),
    clock,
    adapters: createAdapters(env, clock),
    config: () => (cfg ??= getConfig(env, clock.now())),
    now: () => clock.now(),
    defer: (work) => (waitUntil ? waitUntil(quiet(work)) : void held.push(quiet(work))),
    drain: async () => {
      while (held.length) await Promise.all(held.splice(0));
    },
  };
}
