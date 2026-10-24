// Worker bindings, vars and secrets. Keep in sync with wrangler.jsonc and .dev.vars.example.
import type {
  ArchiveMessage,
  CleanupMessage,
  CompressMessage,
  NotifyMessage,
  ScanMessage,
} from './queues/messages';
import type { Clock } from './adapters/clock';

export type AppEnvName = 'dev' | 'staging' | 'production';

export interface Env {
  // ── vars ──
  APP_ENV: AppEnvName;
  APP_ORIGIN: string;
  USERCONTENT_ORIGIN: string;
  EMAIL_FROM: string;
  /** `relay` = HTTPS → SMTP relay Worker (Workers Free, ADR-035). */
  ADAPTER_EMAIL: 'mock' | 'cloudflare' | 'relay';
  MAIL_RELAY_URL?: string;
  /** `zeiko` = Zeiko Accounts on the relay (ADR-036). */
  ADAPTER_PAYMENT: 'mock' | 'zeiko';
  /** Who signs people in: `zeiko` = Zeiko Accounts tickets, `mock` = the dev door (dev only). */
  ADAPTER_ACCOUNTS?: 'mock' | 'zeiko';
  /** The relay's sign-in door, e.g. https://auth.zeiko.biz.id (browser and server both call it). */
  ZEIKO_DOOR_URL?: string;
  /** The website the door belongs to (sign-in pages, payment page), e.g. https://zeiko.biz.id. */
  ZEIKO_SITE_URL?: string;
  /** Where the SPA lives under APP_ORIGIN. */
  APP_BASE_PATH?: string;
  ADAPTER_SCANNER: 'mock' | 'container';
  ADAPTER_CSAM: 'mock';
  /** `mock-nocontainer` = mock without Container `media` (tests the "too large" path). */
  ADAPTER_MEDIA?: 'mock' | 'mock-nocontainer' | 'cloudflare';
  /** `none` = no Container `archiver`: TAR.ZST and large deflate ZIPs are unavailable. */
  ADAPTER_ARCHIVER?: 'mock' | 'container' | 'none';
  TURNSTILE_SITE_KEY?: string;
  SCANNER_INSTANCES?: string;
  /** This environment's R2 bucket, as Cloudflare's analytics name it (ADR-037). */
  R2_BUCKET_NAME?: string;
  /** The Cloudflare account the bucket is in, for R2's analytics (ADR-037). */
  CF_ACCOUNT_ID?: string;
  /** Zeiko S3's own address, e.g. https://s3.zeiko.biz.id (ADR-044). Unset = no S3 API. */
  S3_ORIGIN?: string;

  // ── secrets (wrangler secret / .dev.vars) ──
  BETTER_AUTH_SECRET: string;
  DOWNLOAD_SECRET: string;
  SHARE_LINK_SECRET: string;
  SHARE_LINK_SECRET_PREV?: string;
  PREVIEW_SECRET: string;
  CONTACTS_ENC_KEY: string;
  IP_HASH_SECRET: string;
  PAYMENT_WEBHOOK_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  MAIL_RELAY_TOKEN?: string;
  /** Bearer for the door's /apps/v1 routes (minted on the relay's Zeiko Drive screen). */
  ZEIKO_APP_TOKEN?: string;
  /** The relay's bearer for /api/ops/* and the key its payment callbacks are signed with. */
  ZEIKO_OPS_TOKEN?: string;
  /** API token with Account Analytics: Read, for R2's real usage on the relay's screen (ADR-037). */
  CF_ANALYTICS_TOKEN?: string;
  /** 32 bytes (base64): seals Zeiko S3 secret keys at rest (ADR-044). */
  S3_KEYS_ENC_KEY?: string;

  // ── bindings ──
  DB: D1Database;
  BUCKET: R2Bucket;
  CONFIG_KV: KVNamespace;
  ASSETS: Fetcher;
  SCAN_QUEUE: Queue<ScanMessage>;
  ARCHIVE_QUEUE: Queue<ArchiveMessage>;
  COMPRESS_QUEUE: Queue<CompressMessage>;
  NOTIFY_QUEUE: Queue<NotifyMessage>;
  CLEANUP_QUEUE: Queue<CleanupMessage>;
  ANALYTICS: AnalyticsEngineDataset;
  RL_AUTH: RateLimit;
  RL_UPLOAD: RateLimit;
  RL_SHARE_CREATE: RateLimit;
  RL_SHARE_SEND: RateLimit;
  RL_DOWNLOAD: RateLimit;
  RL_AD_BOOK: RateLimit;
  RL_REPORT: RateLimit;
  IMAGES: ImagesBinding;
  MEDIA: MediaBinding;
  /** Email Sending (Workers Paid). Absent with ADAPTER_EMAIL=relay|mock. */
  EMAIL?: SendEmail;
  /** Containers (absent in local dev; adapters fall back to mocks). */
  SCANNER?: DurableObjectNamespace;
  MEDIA_CONTAINER?: DurableObjectNamespace;
  ARCHIVER?: DurableObjectNamespace;

  // Zeiko S3 accounts may have an index database of their own: D1 bindings named S3_DB_* (ADR-044),
  // looked up by name (services/s3-index.ts), so they are not listed here.

  /** Test/dev only: injected fake clock. Never set in staging/production. */
  CLOCK?: Clock;
}
