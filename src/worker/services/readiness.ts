// Which of Drive's features can be used here and what each still needs (ADR-049). The app hides a
// feature until it is ready (`capabilities`, in the public catalog); the relay's Zeiko Drive screen
// lists every feature with what is missing and how to fill it (`GET /api/ops/readiness`), and puts
// the secrets in Drive's Worker itself.
import type { Ctx } from '../context';
import type { Env } from '../env';
import { replicasAvailable } from './s3-replicas';
import { s3Configured } from './s3';

/**
 * - secret: a Worker secret the relay's Setup can put in (its own allowlist decides which).
 * - deploy: made by `node scripts/cf-setup.mjs <env>` (a binding, a var, a generated secret, the
 *   database tables), so it arrives with the next deploy.
 * - cloudflare: a step in the Cloudflare dashboard, then a line in deploy/<env>.json and a deploy.
 */
export type NeedKind = 'secret' | 'deploy' | 'cloudflare';

export interface Need {
  name: string;
  kind: NeedKind;
  ok: boolean;
  how: string;
}

export type FeatureId =
  | 'sign_in'
  | 'payments'
  | 'email'
  | 's3'
  | 's3_three_copies'
  | 's3_url_zeiko'
  | 's3_url_custom'
  | 'virustotal'
  | 'r2_meters'
  | 'async_archives';

export interface Feature {
  id: FeatureId;
  title: string;
  /** What people get once it is ready; hidden from them until then when `hidden`. */
  what: string;
  /** Hidden in the app until ready (false: works without it, or nobody sees it). */
  hidden: boolean;
  ready: boolean;
  needs: Need[];
  /** Features that have to be ready first. */
  after: FeatureId[];
}

const DEPLOY =
  'Run `node scripts/cf-setup.mjs production` in the Drive repository (it deploys too).';

const secret = (name: string, ok: boolean, how: string): Need => ({
  name,
  kind: 'secret',
  ok,
  how,
});
const deploy = (name: string, ok: boolean, how = DEPLOY): Need => ({
  name,
  kind: 'deploy',
  ok,
  how,
});

// The S3 tables come with migration 0008. Once seen they stay (migrations are never undone).
let s3Tables = false;
async function s3TablesExist(env: Env): Promise<boolean> {
  if (s3Tables) return true;
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 's3_urls'`,
  ).first();
  s3Tables = Boolean(row);
  return s3Tables;
}

/** Dev and tests read the mock mailbox; staging and production need real mail. */
export function realEmail(ctx: Ctx): boolean {
  const env = ctx.env.APP_ENV;
  return ctx.adapters.email.name !== 'mock' || (env !== 'production' && env !== 'staging');
}

export async function readiness(ctx: Ctx): Promise<Feature[]> {
  const env = ctx.env;
  const tables = env.S3_ORIGIN ? await s3TablesExist(env) : false;
  const relayMail = env.ADAPTER_EMAIL !== 'cloudflare';
  // Dev and tests answer own addresses with the mock (never in production): nothing to fill there.
  const mockHosts = ctx.adapters.hostnames?.name === 'mock';
  const cf = (v: string | undefined) => mockHosts || Boolean(v);
  const list: Array<Omit<Feature, 'ready'>> = [
    {
      id: 'sign_in',
      title: 'Sign-in with Zeiko Accounts',
      what: 'People sign in to Drive.',
      hidden: false,
      after: [],
      needs: [
        deploy('ZEIKO_DOOR_URL', Boolean(env.ZEIKO_DOOR_URL)),
        secret(
          'ZEIKO_APP_TOKEN',
          Boolean(env.ZEIKO_APP_TOKEN),
          'Zeiko Drive → Setup → Save and connect Drive.',
        ),
      ],
    },
    {
      id: 'payments',
      title: 'QRIS payments',
      what: 'Plans, add-ons and Zeiko S3 are paid by QRIS.',
      hidden: false,
      after: ['sign_in'],
      needs: [
        secret(
          'ZEIKO_OPS_TOKEN',
          Boolean(env.ZEIKO_OPS_TOKEN),
          'Zeiko Drive → Setup → Save and connect Drive.',
        ),
      ],
    },
    {
      id: 'email',
      title: 'Email',
      what: 'Notices by email, and sharing a link by email.',
      hidden: true,
      after: [],
      needs: relayMail
        ? [
            deploy('MAIL_RELAY_URL', Boolean(env.MAIL_RELAY_URL)),
            secret(
              'MAIL_RELAY_TOKEN',
              realEmail(ctx),
              'The mailer Worker’s token (the same one Zeiko Accounts mails with: Zeiko Accounts → Setup → Mail).',
            ),
          ]
        : [deploy('EMAIL', realEmail(ctx), 'Email Sending needs Workers Paid; then deploy.')],
    },
    {
      id: 's3',
      title: 'Zeiko S3',
      what: 'The Zeiko S3 page, plans paid upfront, and the S3 API at the S3 address.',
      hidden: true,
      after: [],
      needs: [
        deploy('S3_ORIGIN', Boolean(env.S3_ORIGIN)),
        deploy('S3_KEYS_ENC_KEY', Boolean(env.S3_KEYS_ENC_KEY)),
        deploy('migration 0008', tables),
      ],
    },
    {
      id: 's3_three_copies',
      title: 'Zeiko S3: 3 copies',
      what: 'The 3-copy plan (two more R2 buckets in other regions).',
      hidden: true,
      after: ['s3'],
      needs: [
        deploy('S3_REPLICA_A', Boolean(env.S3_REPLICA_A)),
        deploy('S3_REPLICA_B', Boolean(env.S3_REPLICA_B)),
      ],
    },
    {
      id: 's3_url_zeiko',
      title: 'Zeiko S3: s3.<name>.zeiko.biz.id',
      what: 'An S3 address of their own under zeiko.biz.id, sold once.',
      hidden: true,
      after: ['s3'],
      needs: [
        secret(
          'CF_HOSTNAMES_TOKEN',
          cf(env.CF_HOSTNAMES_TOKEN),
          'Cloudflare → My Profile → API Tokens → Create Token → Custom token. Permissions: Account · Workers Scripts · Edit; Zone · Workers Routes · Edit; Zone · SSL and Certificates · Edit; Zone · DNS · Edit. Zone resources: Include · Specific zone · zeiko.biz.id. Paste it here.',
        ),
        secret(
          'CF_ACCOUNT_ID',
          cf(env.CF_ACCOUNT_ID),
          'The account ID from Setup (Workers & Pages, on the right).',
        ),
        deploy('CF_ZONE_ID', cf(env.CF_ZONE_ID)),
        deploy('WORKER_NAME', cf(env.WORKER_NAME)),
        deploy('S3_SUBDOMAIN_SUFFIX', Boolean(env.S3_SUBDOMAIN_SUFFIX)),
      ],
    },
    {
      id: 's3_url_custom',
      title: 'Zeiko S3: a domain of their own',
      what: 'An S3 address on the customer’s own domain (e.g. s3.tokobudi.com), sold once.',
      hidden: true,
      after: ['s3_url_zeiko'],
      needs: [
        {
          name: 'S3_CNAME_TARGET',
          kind: 'cloudflare',
          ok: Boolean(env.S3_CNAME_TARGET),
          how: 'Cloudflare → zeiko.biz.id: (1) SSL/TLS → Custom Hostnames → enable Cloudflare for SaaS; (2) DNS → Add record: AAAA, name custom-s3, IPv6 100::, Proxied; (3) Custom Hostnames → Fallback Origin: custom-s3.zeiko.biz.id. Do not add a */* route. Then add "s3CnameTarget": "custom-s3.zeiko.biz.id" to deploy/production.json and deploy.',
        },
      ],
    },
    {
      id: 'virustotal',
      title: 'VirusTotal',
      what: 'New programs and macro documents are checked with VirusTotal.',
      hidden: false,
      after: [],
      needs: [
        secret(
          'VIRUSTOTAL_API_KEY',
          Boolean(env.VIRUSTOTAL_API_KEY),
          'virustotal.com → your profile → API Key. Paste it here.',
        ),
      ],
    },
    {
      id: 'r2_meters',
      title: 'R2 meters',
      what: 'The R2 storage tab reads Cloudflare’s own usage instead of Drive’s count.',
      hidden: false,
      after: [],
      needs: [
        secret(
          'CF_ACCOUNT_ID',
          Boolean(env.CF_ACCOUNT_ID),
          'The account ID from Setup (Workers & Pages, on the right).',
        ),
        secret(
          'CF_ANALYTICS_TOKEN',
          Boolean(env.CF_ANALYTICS_TOKEN),
          'Cloudflare → API Tokens → Custom token with Account · Account Analytics · Read. Paste it in Setup → R2 analytics token.',
        ),
      ],
    },
    {
      id: 'async_archives',
      title: 'TAR.ZST and large ZIP downloads',
      what: 'Downloading a big folder as TAR.ZST or a compressed ZIP.',
      hidden: true,
      after: [],
      needs: [
        deploy(
          'ARCHIVER',
          ctx.adapters.archiver.name !== 'none',
          'Needs Workers Paid (Containers): set "plan": "paid" in deploy/production.json and deploy from CI.',
        ),
      ],
    },
  ];

  const ready = new Map<FeatureId, boolean>();
  const out: Feature[] = [];
  for (const f of list) {
    const ok = f.needs.every((n) => n.ok) && f.after.every((a) => ready.get(a) === true);
    ready.set(f.id, ok);
    out.push({ ...f, ready: ok });
  }
  return out;
}

/** What the app shows (the public catalog's `capabilities`): only what works here. */
export async function capabilities(ctx: Ctx) {
  const env = ctx.env;
  const s3 = s3Configured(env) && (await s3TablesExist(env));
  const hostnames = s3 && ctx.adapters.hostnames !== null;
  return {
    asyncArchives: ctx.adapters.archiver.name !== 'none',
    emailShare: realEmail(ctx),
    s3,
    s3ThreeCopies: s3 && replicasAvailable(env),
    s3UrlZeiko: hostnames && Boolean(env.S3_SUBDOMAIN_SUFFIX),
    s3UrlCustom: hostnames && Boolean(env.S3_CNAME_TARGET),
  };
}

export type Capabilities = Awaited<ReturnType<typeof capabilities>>;
