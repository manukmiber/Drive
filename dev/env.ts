// Builds a complete Env out of shims and wires the real Worker (fetch/queue/scheduled) to it.
// Used by the dev server and by integration tests.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/env';
import type { QueueMessage } from '../src/worker/queues/messages';
import type { Clock } from '../src/worker/adapters/clock';
import { runScheduled } from '../src/worker/cron';
import { ShimD1Database, openSqlite } from './shims/d1';
import { ShimKV } from './shims/kv';
import { ShimR2Bucket } from './shims/r2';
import { ShimQueue } from './shims/queue';
import {
  ShimAnalytics,
  ShimAssets,
  ShimRateLimit,
  ShimSendEmail,
  unsupportedBinding,
} from './shims/misc';
import { applyMigrations, migrationsFingerprint } from './migrate';
import { DEV_DEFAULTS } from './vars';

const ROOT = join(import.meta.dirname, '..');

export interface DevRuntimeOptions {
  /** Persist data here (dev server). Omit for a throwaway temp dir (tests). */
  dataDir?: string;
  vars?: Record<string, string>;
  queueMode?: 'auto' | 'manual';
  clock?: Clock;
  /** Extra (empty, in-memory) D1 bindings, e.g. a Zeiko S3 account's own index `S3_DB_A`. */
  extraD1?: string[];
  /** Rate limits per binding; tests default to effectively unlimited. */
  rateLimits?: Partial<Record<RateLimitName, { limit: number; period: number }>>;
}

export const RATE_LIMIT_NAMES = [
  'RL_AUTH',
  'RL_UPLOAD',
  'RL_SHARE_CREATE',
  'RL_SHARE_SEND',
  'RL_DOWNLOAD',
  'RL_AD_BOOK',
  'RL_REPORT',
  'RL_API',
] as const;
export type RateLimitName = (typeof RATE_LIMIT_NAMES)[number];

/** Mirrors wrangler.jsonc ratelimits. */
export const DEFAULT_RATE_LIMITS: Record<RateLimitName, { limit: number; period: number }> = {
  RL_AUTH: { limit: 10, period: 60 },
  RL_UPLOAD: { limit: 120, period: 60 },
  RL_SHARE_CREATE: { limit: 30, period: 60 },
  RL_SHARE_SEND: { limit: 10, period: 60 },
  RL_DOWNLOAD: { limit: 600, period: 60 },
  RL_AD_BOOK: { limit: 20, period: 60 },
  RL_REPORT: { limit: 5, period: 60 },
  RL_API: { limit: 300, period: 60 },
};

const QUEUES = {
  SCAN_QUEUE: 'zeiko-scan-dev',
  ARCHIVE_QUEUE: 'zeiko-archive-dev',
  COMPRESS_QUEUE: 'zeiko-compress-dev',
  NOTIFY_QUEUE: 'zeiko-notify-dev',
  CLEANUP_QUEUE: 'zeiko-cleanup-dev',
} as const;
type QueueBinding = keyof typeof QUEUES;

export interface DevRuntime {
  env: Env;
  d1: ShimD1Database;
  kv: ShimKV;
  r2: ShimR2Bucket;
  queues: Record<QueueBinding, ShimQueue<QueueMessage>>;
  analytics: ShimAnalytics;
  email: ShimSendEmail;
  rateLimits: Record<RateLimitName, ShimRateLimit>;
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  /** Waits for ctx.waitUntil() work and (in manual mode) drains every queue. */
  settle(): Promise<void>;
  runCron(cron: string): Promise<{ ran: string[]; failed: string[] }>;
  close(): void;
}

export async function createDevRuntime(opts: DevRuntimeOptions = {}): Promise<DevRuntime> {
  const temp = !opts.dataDir;
  const dir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'zeiko-'));
  mkdirSync(dir, { recursive: true });
  if (!temp) {
    // Migrations may still be edited before the first remote deploy (ADR-011): if an applied one
    // changed, the local data no longer matches the schema — start over (dev data only).
    const stamp = join(dir, 'migrations.sha256');
    const fp = migrationsFingerprint();
    if (existsSync(stamp) && readFileSync(stamp, 'utf8') !== fp) {
      console.warn('[zeiko] migrasi berubah → data dev lokal direset');
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
    }
    writeFileSync(stamp, fp);
  }
  const now = () => (opts.clock ? opts.clock.now() : Date.now());

  const sqlite = openSqlite(temp ? ':memory:' : join(dir, 'd1.sqlite'));
  applyMigrations(sqlite);
  const d1 = new ShimD1Database(sqlite);
  const kv = new ShimKV(openSqlite(temp ? ':memory:' : join(dir, 'kv.sqlite')), now);
  const r2 = await new ShimR2Bucket(join(dir, 'r2'), now).init();
  // Zeiko S3's replica buckets (ADR-047), so 3-copy plans work locally.
  const replicaA = await new ShimR2Bucket(join(dir, 'r2-replica-a'), now).init();
  const replicaB = await new ShimR2Bucket(join(dir, 'r2-replica-b'), now).init();
  const analytics = new ShimAnalytics();
  const email = new ShimSendEmail();

  const mode = opts.queueMode ?? (temp ? 'manual' : 'auto');
  const queues = Object.fromEntries(
    Object.entries(QUEUES).map(([binding, name]) => [
      binding,
      new ShimQueue<QueueMessage>(name, { mode, maxRetries: 3, maxBatchSize: 10 }),
    ]),
  ) as Record<QueueBinding, ShimQueue<QueueMessage>>;

  const limits = { ...(temp ? {} : DEFAULT_RATE_LIMITS), ...opts.rateLimits };
  const rateLimits = Object.fromEntries(
    RATE_LIMIT_NAMES.map((n) => [
      n,
      new ShimRateLimit(limits[n] ?? { limit: 1_000_000, period: 60 }),
    ]),
  ) as Record<RateLimitName, ShimRateLimit>;

  const extraD1 = Object.fromEntries(
    (opts.extraD1 ?? []).map((name) => [name, new ShimD1Database(openSqlite(':memory:'))]),
  );

  const env = {
    ...DEV_DEFAULTS,
    ...opts.vars,
    ...extraD1,
    DB: d1,
    BUCKET: r2,
    S3_REPLICA_A: replicaA,
    S3_REPLICA_B: replicaB,
    CONFIG_KV: kv,
    ASSETS: new ShimAssets(join(ROOT, 'dist', 'web')),
    ...queues,
    ANALYTICS: analytics,
    ...rateLimits,
    IMAGES: unsupportedBinding('IMAGES'),
    MEDIA: unsupportedBinding('MEDIA'),
    EMAIL: email,
    ...(opts.clock ? { CLOCK: opts.clock } : {}),
  } as unknown as Env;

  const waits = new Set<Promise<unknown>>();
  const execCtx = (): ExecutionContext =>
    ({
      waitUntil: (p: Promise<unknown>) => {
        const tracked = p
          .catch((e) => console.error('[waitUntil]', e))
          .finally(() => waits.delete(tracked));
        waits.add(tracked);
      },
      passThroughOnException: () => {},
      props: {},
    }) as unknown as ExecutionContext;

  for (const q of Object.values(queues)) {
    q.setConsumer((batch) => worker.queue(batch as unknown as MessageBatch<QueueMessage>, env));
  }

  return {
    env,
    d1,
    kv,
    r2,
    queues,
    analytics,
    email,
    rateLimits,
    fetch: async (input, init) => {
      const req =
        typeof input === 'string' ? new Request(new URL(input, env.APP_ORIGIN), init) : input;
      return worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, env, execCtx());
    },
    settle: async () => {
      for (let i = 0; i < 20; i++) {
        await Promise.all([...waits]);
        let delivered = 0;
        if (mode === 'manual') for (const q of Object.values(queues)) delivered += await q.drain();
        if (!waits.size && !delivered) return;
      }
    },
    runCron: (cron) => runScheduled(cron, env),
    close: () => {
      sqlite.close();
      if (temp) rmSync(dir, { recursive: true, force: true });
    },
  };
}
