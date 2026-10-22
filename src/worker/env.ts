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
  ADAPTER_EMAIL: 'mock' | 'cloudflare';
  ADAPTER_PAYMENT: 'mock';
  ADAPTER_SCANNER: 'mock' | 'container';
  ADAPTER_CSAM: 'mock';
  /** `mock-nocontainer` = mock without Container `media` (tests the "too large" path). */
  ADAPTER_MEDIA?: 'mock' | 'mock-nocontainer' | 'cloudflare';
  TURNSTILE_SITE_KEY?: string;
  ADMIN_ALERT_TELEGRAM_CHAT_ID?: string;
  SCANNER_INSTANCES?: string;
  TELEGRAM_BOT_USERNAME?: string;

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
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;

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
  EMAIL: SendEmail;
  /** Containers (absent in local dev; adapters fall back to mocks). */
  SCANNER?: DurableObjectNamespace;
  MEDIA_CONTAINER?: DurableObjectNamespace;

  /** Test/dev only: injected fake clock. Never set in staging/production. */
  CLOCK?: Clock;
}
