// Regenerate with: node scripts/gen-wrangler.mjs > wrangler.jsonc
// Remote resource IDs and per-env overrides live in deploy/{staging,production}.json (written by
// scripts/cf-setup.mjs; IDs only, no secrets).
import { existsSync, readFileSync } from 'node:fs';

function deployFile(env) {
  const f = new URL(`../deploy/${env}.json`, import.meta.url);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
}
const Q = ['scan', 'archive', 'compress', 'notify', 'cleanup'];
// Containers (SPEC §2). Each gets a Durable Object binding with the same class.
const CONTAINERS = [
  {
    binding: 'SCANNER',
    class_name: 'ScannerContainer',
    image: './containers/scanner/Dockerfile',
    instance_type: 'standard-1',
    max_instances: 10,
  },
];
const RL = [
  ['RL_AUTH', 10],
  ['RL_UPLOAD', 120],
  ['RL_SHARE_CREATE', 30],
  ['RL_SHARE_SEND', 10],
  ['RL_DOWNLOAD', 600],
  ['RL_AD_BOOK', 20],
  ['RL_REPORT', 5],
];
function bindings(env, nsBase, ids) {
  // Containers need Docker at deploy time; `containers: false` deploys without them and falls back
  // to the built-in hashing scanner (ADR-027).
  // ZK_CONTAINERS=1|0 overrides (CI with Docker forces them on).
  const force = process.env.ZK_CONTAINERS;
  const containers = env !== 'dev' && (force ? force === '1' : ids.containers !== false);
  return {
    vars: {
      APP_ENV: env,
      APP_ORIGIN: ids.app,
      USERCONTENT_ORIGIN: ids.uc,
      EMAIL_FROM: 'no-reply@zeiko.biz.id',
      ADAPTER_EMAIL: env === 'dev' ? 'mock' : 'cloudflare',
      ADAPTER_PAYMENT: 'mock',
      ADAPTER_SCANNER: containers ? 'container' : 'mock',
      ADAPTER_CSAM: 'mock',
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: `zeiko-${env}`,
        database_id: ids.d1,
        migrations_dir: 'migrations',
      },
    ],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: `zeiko-${env}` }],
    kv_namespaces: [{ binding: 'CONFIG_KV', id: ids.kv }],
    queues: {
      producers: Q.map((q) => ({
        binding: `${q.toUpperCase()}_QUEUE`,
        queue: `zeiko-${q}-${env}`,
      })),
      consumers: Q.map((q) => ({
        queue: `zeiko-${q}-${env}`,
        max_batch_size: q === 'scan' || q === 'archive' || q === 'compress' ? 1 : 10,
        max_batch_timeout: 5,
        max_retries: 3,
        dead_letter_queue: `zeiko-dlq-${env}`,
      })),
    },
    analytics_engine_datasets: [{ binding: 'ANALYTICS', dataset: `zeiko_events_${env}` }],
    ratelimits: RL.map(([name, limit], i) => ({
      name,
      namespace_id: String(nsBase + i + 1),
      simple: { limit, period: 60 },
    })),
    images: { binding: 'IMAGES' },
    media: { binding: 'MEDIA' },
    send_email: [{ name: 'EMAIL', allowed_sender_addresses: ['no-reply@zeiko.biz.id'] }],
    ...(!containers
      ? {}
      : {
          containers: CONTAINERS.map(({ binding: _b, ...c }) => c),
          durable_objects: {
            bindings: CONTAINERS.map((c) => ({ name: c.binding, class_name: c.class_name })),
          },
        }),
  };
}
function envBlock(env, nsBase, defaults) {
  const d = { ...defaults, ...deployFile(env) };
  const app = d.appOrigin;
  const uc = d.usercontentOrigin;
  return {
    routes: [
      { pattern: new URL(app).hostname, custom_domain: true },
      { pattern: new URL(uc).hostname, custom_domain: true },
    ],
    ...bindings(env, nsBase, { app, uc, d1: d.d1Id, kv: d.kvId, containers: d.containers }),
  };
}

const config = {
  $schema: './node_modules/wrangler/config-schema.json',
  name: 'zeiko',
  main: 'src/worker/entry.ts',
  compatibility_date: '2026-10-01',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: false,
  observability: { enabled: true },
  assets: {
    directory: './dist/web',
    binding: 'ASSETS',
    not_found_handling: 'single-page-application',
    run_worker_first: true,
  },
  triggers: { crons: ['5 17 * * *', '0 * * * *', '0 19 * * *'] },
  migrations: [{ tag: 'v1', new_sqlite_classes: CONTAINERS.map((c) => c.class_name) }],
  ...bindings('dev', 900, {
    app: 'http://localhost:5173',
    uc: 'http://uc.localhost:8790',
    d1: 'local-dev',
    kv: 'local-dev',
  }),
  env: {
    staging: envBlock('staging', 1000, {
      appOrigin: 'https://staging.zeiko.biz.id',
      usercontentOrigin: 'https://uc-staging.zeiko.biz.id',
      d1Id: 'REPLACE_WITH_STAGING_D1_ID',
      kvId: 'REPLACE_WITH_STAGING_KV_ID',
    }),
    production: envBlock('production', 2000, {
      appOrigin: 'https://zeiko.biz.id',
      usercontentOrigin: 'https://uc.zeiko.biz.id',
      d1Id: 'REPLACE_WITH_PRODUCTION_D1_ID',
      kvId: 'REPLACE_WITH_PRODUCTION_KV_ID',
    }),
  },
  // Hashing multi-GB files in the scan consumer needs more than the 30 s default CPU budget.
  limits: { cpu_ms: 300000 },
};
const header = `// Zeiko Cloud Storage — Wrangler config.
// Top level = local dev reference only (dev runs on Node shims, ADR-001; never deployed).
// Bindings are not inherited by environments, so staging/production repeat them.
// Secrets (wrangler secret put …): BETTER_AUTH_SECRET, DOWNLOAD_SECRET, SHARE_LINK_SECRET,
//   SHARE_LINK_SECRET_PREV (rotation only), PREVIEW_SECRET, CONTACTS_ENC_KEY, IP_HASH_SECRET,
//   PAYMENT_WEBHOOK_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TELEGRAM_BOT_TOKEN,
//   TELEGRAM_WEBHOOK_SECRET, TURNSTILE_SECRET_KEY.
// REPLACE_WITH_* ids are filled by scripts/cf-setup.mjs (deploy/{env}.json).
`;
process.stdout.write(header + JSON.stringify(config, null, 2) + '\n');
