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
    binding: 'ARCHIVER',
    class_name: 'ArchiverContainer',
    image: './containers/archiver/Dockerfile',
    instance_type: 'standard-2',
    max_instances: 5,
  },
  {
    binding: 'MEDIA_CONTAINER',
    class_name: 'MediaContainer',
    image: './containers/media/Dockerfile',
    instance_type: 'standard-2',
    max_instances: 5,
  },
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
  // Email Sending needs Workers Paid; on Free use the HTTPS→SMTP relay (or mock), ADR-035.
  const email = env === 'dev' ? 'mock' : (ids.email ?? 'cloudflare');
  return {
    vars: {
      APP_ENV: env,
      APP_ORIGIN: ids.app,
      USERCONTENT_ORIGIN: ids.uc,
      // Zeiko S3's own host (ADR-044); its secret key seal is the S3_KEYS_ENC_KEY secret.
      S3_ORIGIN: ids.s3,
      // Own S3 addresses (ADR-048): s3.<name>.<suffix>, or a person's domain CNAMEd to the target
      // (the zone's Cloudflare for SaaS fallback origin). Live once CF_HOSTNAMES_TOKEN is set.
      ...(env === 'dev'
        ? {}
        : {
            WORKER_NAME: `zeiko-${env}`,
            S3_SUBDOMAIN_SUFFIX: ids.s3SubdomainSuffix,
            // Set only once Cloudflare for SaaS and its fallback origin exist (DEPLOY.md); until then
            // a person's own domain is not offered.
            ...(ids.s3CnameTarget ? { S3_CNAME_TARGET: ids.s3CnameTarget } : {}),
            ...(ids.zoneId ? { CF_ZONE_ID: ids.zoneId } : {}),
            // Turnstile's public site key (ADR-056); its secret is TURNSTILE_SECRET_KEY.
            ...(ids.turnstileSiteKey ? { TURNSTILE_SITE_KEY: ids.turnstileSiteKey } : {}),
          }),
      EMAIL_FROM: 'no-reply@zeiko.biz.id',
      ADAPTER_EMAIL: email,
      ...(email === 'relay'
        ? { MAIL_RELAY_URL: ids.mailRelayUrl ?? 'https://mailer.zeiko.biz.id' }
        : {}),
      // Zeiko Accounts (ADR-036): sign-in tickets and payments through the relay's door. Its two
      // secrets (ZEIKO_APP_TOKEN, ZEIKO_OPS_TOKEN) come from the relay's Zeiko Drive screen.
      ADAPTER_PAYMENT: env === 'dev' ? 'mock' : (ids.payment ?? 'zeiko'),
      ADAPTER_ACCOUNTS: env === 'dev' ? 'mock' : 'zeiko',
      ...(env === 'dev'
        ? {}
        : {
            ZEIKO_DOOR_URL: ids.door ?? 'https://auth.zeiko.biz.id',
            ZEIKO_SITE_URL: ids.site ?? 'https://zeiko.biz.id',
          }),
      ADAPTER_SCANNER: containers ? 'container' : 'mock',
      ADAPTER_CSAM: 'mock',
      ADAPTER_MEDIA: env === 'dev' ? 'mock' : 'cloudflare',
      ADAPTER_ARCHIVER: env === 'dev' ? 'mock' : containers ? 'container' : 'none',
      // The bucket R2's own meters are read for (the relay's storage tab, ADR-037).
      R2_BUCKET_NAME: `zeiko-${env}`,
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: `zeiko-${env}`,
        database_id: ids.d1,
        migrations_dir: 'migrations',
      },
      // Zeiko S3 accounts with an index of their own (ADR-044): one D1 each, named S3_DB_*. The list
      // lives in deploy/{env}.json (`s3Indexes`) so a deploy keeps every one the relay added.
      ...(ids.s3Indexes ?? []).map((x) => ({
        binding: x.binding,
        database_name: x.name,
        database_id: x.id,
      })),
    ],
    r2_buckets: [
      { binding: 'BUCKET', bucket_name: `zeiko-${env}` },
      // Zeiko S3's second and third copies (ADR-047), once cf-setup has made the buckets.
      ...(ids.s3Replicas
        ? [
            { binding: 'S3_REPLICA_A', bucket_name: `zeiko-s3-replica-a-${env}` },
            { binding: 'S3_REPLICA_B', bucket_name: `zeiko-s3-replica-b-${env}` },
          ]
        : []),
    ],
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
    ...(email === 'cloudflare' || env === 'dev'
      ? { send_email: [{ name: 'EMAIL', allowed_sender_addresses: ['no-reply@zeiko.biz.id'] }] }
      : {}),
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
// Hashing multi-GB files in the scan consumer needs more than the 30 s default CPU budget, so
// `limits` is per environment (it is inheritable, and Workers Free refuses it).
function envBlock(env, nsBase, defaults) {
  const d = { ...defaults, ...deployFile(env) };
  const app = d.appOrigin;
  const uc = d.usercontentOrigin;
  const s3 = d.s3Origin;
  for (const x of d.s3Indexes ?? []) {
    if (!/^S3_DB_[A-Z0-9_]{1,40}$/.test(x.binding) || !x.id || !x.name)
      throw new Error(`deploy/${env}.json: bad s3Indexes entry ${JSON.stringify(x)}`);
  }
  return {
    routes: [
      { pattern: new URL(app).hostname, custom_domain: true },
      { pattern: new URL(uc).hostname, custom_domain: true },
      { pattern: new URL(s3).hostname, custom_domain: true },
    ],
    // Workers Free rejects a custom CPU limit (it is fixed at 10 ms there, ADR-035).
    ...(d.plan === 'free'
      ? // One trigger instead of three: Free has 5 cron triggers per account (ADR-035).
        { triggers: { crons: ['5 * * * *'] } }
      : { limits: { cpu_ms: 300000 } }),
    ...bindings(env, nsBase, {
      app,
      uc,
      s3,
      s3Indexes: d.s3Indexes,
      s3Replicas: d.s3Replicas,
      s3SubdomainSuffix: d.s3SubdomainSuffix,
      s3CnameTarget: d.s3CnameTarget,
      zoneId: d.zoneId,
      d1: d.d1Id,
      kv: d.kvId,
      containers: d.containers,
      email: d.email,
      mailRelayUrl: d.mailRelayUrl,
    }),
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
    // The Worker serves the SPA's index itself (src/worker/app.ts), so a path that is the Worker's
    // own (a share link, a download) is never answered with the app.
    not_found_handling: 'none',
    run_worker_first: true,
  },
  triggers: { crons: ['5 17 * * *', '0 * * * *', '0 19 * * *'] },
  migrations: [{ tag: 'v1', new_sqlite_classes: CONTAINERS.map((c) => c.class_name) }],
  ...bindings('dev', 900, {
    app: 'http://localhost:5173',
    uc: 'http://uc.localhost:8790',
    s3: 'http://s3.localhost:8790',
    d1: 'local-dev',
    kv: 'local-dev',
  }),
  env: {
    staging: envBlock('staging', 1000, {
      appOrigin: 'https://staging.zeiko.biz.id',
      usercontentOrigin: 'https://uc-staging.zeiko.biz.id',
      s3Origin: 'https://s3-staging.zeiko.biz.id',
      s3SubdomainSuffix: 'staging.zeiko.biz.id',
      d1Id: 'REPLACE_WITH_STAGING_D1_ID',
      kvId: 'REPLACE_WITH_STAGING_KV_ID',
    }),
    // Drive's own address (ADR-038); the website keeps zeiko.biz.id.
    production: envBlock('production', 2000, {
      appOrigin: 'https://drive.zeiko.biz.id',
      usercontentOrigin: 'https://uc.zeiko.biz.id',
      s3Origin: 'https://s3.zeiko.biz.id',
      s3SubdomainSuffix: 'zeiko.biz.id',
      d1Id: 'REPLACE_WITH_PRODUCTION_D1_ID',
      kvId: 'REPLACE_WITH_PRODUCTION_KV_ID',
    }),
  },
};
const header = `// Zeiko Cloud Storage — Wrangler config.
// Top level = local dev reference only (dev runs on Node shims, ADR-001; never deployed).
// Bindings are not inherited by environments, so staging/production repeat them.
// Secrets (wrangler secret put …): BETTER_AUTH_SECRET, DOWNLOAD_SECRET, SHARE_LINK_SECRET,
//   SHARE_LINK_SECRET_PREV (rotation only), PREVIEW_SECRET, CONTACTS_ENC_KEY, IP_HASH_SECRET,
//   PAYMENT_WEBHOOK_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TELEGRAM_BOT_TOKEN,
//   TELEGRAM_WEBHOOK_SECRET, TURNSTILE_SECRET_KEY, MAIL_RELAY_TOKEN (ADAPTER_EMAIL=relay only).
//   ZEIKO_APP_TOKEN, ZEIKO_OPS_TOKEN (minted on the relay's Zeiko Drive screen, ADR-036).
//   CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN (R2's own meters for the relay's storage tab, ADR-037).
//   S3_KEYS_ENC_KEY (32 random bytes, generated by cf-setup: seals Zeiko S3 secret keys, ADR-044).
//   VIRUSTOTAL_API_KEY (the owner's; unset = no VirusTotal in the scan, ADR-046).
//   CF_HOSTNAMES_TOKEN (the owner's; own Zeiko S3 addresses, ADR-048; needs CF_ACCOUNT_ID and the
//   zone id as "zoneId" in deploy/{env}.json).
// REPLACE_WITH_* ids are filled by scripts/cf-setup.mjs (deploy/{env}.json).
`;
process.stdout.write(header + JSON.stringify(config, null, 2) + '\n');
