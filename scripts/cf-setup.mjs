// One-command Cloudflare setup for an environment (idempotent; safe to re-run):
//   node scripts/cf-setup.mjs staging [--dry-run] [--no-containers] [--skip-deploy]
//       [--containers-ready] [--app-origin https://… --uc-origin https://…]
//       [--plan free|paid] [--email cloudflare|relay|mock]
// `--plan free` (Workers Free: no CPU limit override, no containers) usually goes with
// `--email relay` (HTTPS→SMTP relay Worker) or `--email mock` (OTP only in KV), ADR-035.
// Creates D1 / KV / R2 / Queues, writes their IDs to deploy/{env}.json, regenerates wrangler.jsonc,
// applies D1 migrations, deploys, and sets any missing secrets to fresh random values. Secret values
// are never printed or written to the repo.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const env = args[0];
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
if (env !== 'staging' && env !== 'production') {
  console.error(
    'pakai: node scripts/cf-setup.mjs <staging|production> [--dry-run] [--no-containers] [--skip-deploy]',
  );
  process.exit(1);
}
const DRY = flag('--dry-run');
const QUEUES = ['scan', 'archive', 'compress', 'notify', 'cleanup', 'dlq'];
const GENERATED_SECRETS = [
  'BETTER_AUTH_SECRET',
  'DOWNLOAD_SECRET',
  'SHARE_LINK_SECRET',
  'PREVIEW_SECRET',
  'CONTACTS_ENC_KEY',
  'IP_HASH_SECRET',
  'PAYMENT_WEBHOOK_SECRET',
  // Seals Zeiko S3 secret keys (ADR-044); a new one makes every existing S3 key unusable.
  'S3_KEYS_ENC_KEY',
  'TELEGRAM_WEBHOOK_SECRET',
];
// ZEIKO_APP_TOKEN and ZEIKO_OPS_TOKEN are the relay's (Zeiko Drive → Setup → Connect Drive, ADR-036):
// without the first nobody can sign in, without the second no payment is confirmed.
const OWNER_SECRETS = [
  'ZEIKO_APP_TOKEN',
  'ZEIKO_OPS_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TURNSTILE_SECRET_KEY',
  // The owner's VirusTotal key (ADR-046); without it the scan simply skips VirusTotal.
  'VIRUSTOTAL_API_KEY',
];

function wrangler(argv, { json = false, allowFail = false, input } = {}) {
  const shown = `wrangler ${argv.join(' ')}`;
  if (DRY && !json) {
    console.log(`[dry-run] ${shown}`);
    return '';
  }
  const r = spawnSync('npx', ['wrangler', ...argv], {
    cwd: root,
    encoding: 'utf8',
    input,
    maxBuffer: 64 << 20,
  });
  if (r.status !== 0 && !allowFail) {
    console.error(`✗ ${shown}\n${r.stderr || r.stdout}`);
    process.exit(1);
  }
  // JSON output is stdout only: stderr carries config warnings that would break the parse.
  if (json) return r.stdout ?? '';
  return (r.stdout ?? '') + (allowFail ? (r.stderr ?? '') : '');
}

function parseJson(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

console.log(`\n▶ Zeiko setup: ${env}${DRY ? ' (dry-run)' : ''}\n`);

// 0. Auth
const who = spawnSync('npx', ['wrangler', 'whoami'], { cwd: root, encoding: 'utf8' });
if (!/You are logged in|associated with the email|Account ID/i.test(who.stdout + who.stderr)) {
  console.error(
    'Belum login ke Cloudflare. Jalankan: npx wrangler login   (atau set CLOUDFLARE_API_TOKEN)',
  );
  if (!DRY) process.exit(1);
}

const deployPath = join(root, 'deploy', `${env}.json`);
const state = existsSync(deployPath) ? JSON.parse(readFileSync(deployPath, 'utf8')) : {};
if (opt('--app-origin')) state.appOrigin = opt('--app-origin');
if (opt('--uc-origin')) state.usercontentOrigin = opt('--uc-origin');
if (flag('--no-containers')) state.containers = false;
if (opt('--plan')) state.plan = opt('--plan');
if (opt('--email')) state.email = opt('--email');
if (state.plan === 'free') state.containers = false; // Containers need Workers Paid
// After CI (with Docker) has pushed the scanner image once, switch this env to ClamAV for good.
if (flag('--containers-ready'))
  Object.assign(state, { containers: true, containersDeployed: true, containersAuto: false });

// 1. D1
const dbName = `zeiko-${env}`;
const d1List = parseJson(wrangler(['d1', 'list', '--json'], { json: true, allowFail: true })) ?? [];
let d1 = d1List.find((d) => d.name === dbName);
if (!d1) {
  wrangler(['d1', 'create', dbName]);
  d1 = (parseJson(wrangler(['d1', 'list', '--json'], { json: true, allowFail: true })) ?? []).find(
    (d) => d.name === dbName,
  );
}
if (d1) state.d1Id = d1.uuid;
console.log(`✓ D1 ${dbName} ${state.d1Id ?? '(dibuat saat run)'}`);

// 2. KV
const kvTitle = `zeiko-config-${env}`;
const kvList = () =>
  parseJson(wrangler(['kv', 'namespace', 'list'], { json: true, allowFail: true })) ?? [];
let kv = kvList().find((k) => k.title === kvTitle);
if (!kv) {
  wrangler(['kv', 'namespace', 'create', kvTitle]);
  kv = kvList().find((k) => k.title === kvTitle);
}
if (kv) state.kvId = kv.id;
console.log(`✓ KV ${kvTitle} ${state.kvId ?? '(dibuat saat run)'}`);

// 3. R2 (private bucket; no public access, no custom domain)
const bucket = `zeiko-${env}`;
const r2 = wrangler(['r2', 'bucket', 'create', bucket], { allowFail: true });
console.log(`✓ R2 ${bucket}${/already exists/i.test(r2) ? ' (sudah ada)' : ''}`);
// Zeiko S3's 3-copy plans (ADR-047): two more private buckets, placed in other regions.
for (const [suffix, location] of [
  ['a', 'weur'],
  ['b', 'wnam'],
]) {
  const name = `zeiko-s3-replica-${suffix}-${env}`;
  const out = wrangler(['r2', 'bucket', 'create', name, '--location', location], {
    allowFail: true,
  });
  console.log(`✓ R2 ${name} (${location})${/already exists/i.test(out) ? ' (sudah ada)' : ''}`);
}
state.s3Replicas = true;

// 4. Queues
for (const q of QUEUES) {
  const name = `zeiko-${q}-${env}`;
  const out = wrangler(['queues', 'create', name], { allowFail: true });
  console.log(`✓ Queue ${name}${/already (exists|taken)/i.test(out) ? ' (sudah ada)' : ''}`);
}

// 5. Config. Without Docker the scanner image can't be built here: unless an earlier deploy (CI)
// already pushed it, fall back to the built-in hashing scanner instead of a container that
// doesn't exist (files would stay "scanning" forever).
const docker = spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;
if (state.containers !== false && !docker && !state.containersDeployed) {
  console.warn(
    '! Docker tidak ada dan image scanner belum pernah di-deploy → pakai scanner bawaan (hash + EICAR + blocklist).',
  );
  console.warn(
    '  Untuk ClamAV: deploy dari CI (GitHub Actions punya Docker), lalu jalankan ulang skrip ini.',
  );
  state.containers = false;
  state.containersAuto = true;
}
if (!DRY) writeFileSync(deployPath, JSON.stringify(state, null, 2) + '\n');
const generated = execFileSync('node', [join(root, 'scripts', 'gen-wrangler.mjs')], {
  encoding: 'utf8',
});
if (!DRY) writeFileSync(join(root, 'wrangler.jsonc'), generated);
console.log(`✓ deploy/${env}.json + wrangler.jsonc diperbarui`);

// 6. Migrations
wrangler(['d1', 'migrations', 'apply', dbName, '--remote', '--env', env]);
console.log('✓ migrasi D1 diterapkan');

// 7. Build + deploy
if (!flag('--skip-deploy')) {
  if (!DRY) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  const rollout = state.containers !== false && !docker ? ['--containers-rollout=none'] : [];
  wrangler(['deploy', '--env', env, ...rollout]);
  if (state.containers !== false && docker && !DRY) {
    state.containersDeployed = true;
    writeFileSync(deployPath, JSON.stringify(state, null, 2) + '\n');
  }
  console.log('✓ Worker ter-deploy');
}

// 8. Secrets: create the missing ones with random values (never printed).
const secretList = DRY
  ? []
  : parseJson(wrangler(['secret', 'list', '--env', env], { json: true, allowFail: true }));
// Never guess: an unreadable list would make every secret look missing and replace them all
// (a new CONTACTS_ENC_KEY makes stored contacts unreadable).
if (!Array.isArray(secretList)) {
  console.error('✗ daftar secret tidak bisa dibaca; berhenti supaya secret lama tidak tertimpa.');
  process.exit(1);
}
const existing = new Set(secretList.map((s) => s.name));
const missing = GENERATED_SECRETS.filter((s) => !existing.has(s));
if (missing.length && !DRY) {
  const dir = mkdtempSync(join(tmpdir(), 'zk-secrets-'));
  const file = join(dir, 's.json');
  writeFileSync(
    file,
    JSON.stringify(
      Object.fromEntries(missing.map((k) => [k, randomBytes(32).toString('base64url')])),
    ),
  );
  chmodSync(file, 0o600);
  try {
    wrangler(['secret', 'bulk', file, '--env', env]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(
  `✓ secret: ${missing.length ? `${missing.length} dibuat (${missing.join(', ')})` : 'lengkap'}`,
);
const ownerMissing = [
  ...OWNER_SECRETS,
  ...(state.email === 'relay' ? ['MAIL_RELAY_TOKEN'] : []),
].filter((s) => !existing.has(s));
if (ownerMissing.length) {
  console.log(
    `  opsional, isi sendiri bila dipakai: ${ownerMissing.map((s) => `npx wrangler secret put ${s} --env ${env}`).join('\n    ')}`,
  );
}

console.log(
  `\nSelesai. App: ${state.appOrigin ?? (env === 'staging' ? 'https://staging.zeiko.biz.id' : 'https://drive.zeiko.biz.id')}\n`,
);
