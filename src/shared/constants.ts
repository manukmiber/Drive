// Fixed technical constants (platform limits, formats). Business numbers live in config-defaults.ts.

export const KIB = 1024;
export const MIB = 1024 * KIB;
/** "GB" in the UI and in quotas is 2^30 bytes (SPEC §0.2). */
export const GIB = 1024 * MIB;

/** R2 multipart rules (SPEC §5.2, ADR-006). */
export const R2_MAX_PARTS = 10_000;
export const R2_MIN_PART_BYTES = 5 * MIB;
export const UPLOAD_PART_MIN_BYTES = 16 * MIB;
export const UPLOAD_PART_MAX_BYTES = 64 * MIB;
/** Largest single file the protocol can carry: 64 MiB × 10,000 parts = 625 GiB. */
export const UPLOAD_MAX_FILE_BYTES = UPLOAD_PART_MAX_BYTES * R2_MAX_PARTS;
export const SIMPLE_UPLOAD_MAX_BYTES = 16 * MIB;

/** Share link format (SPEC §6.1). */
export const SHARE_ID_LENGTH = 64;
export const SHARE_SIG_LENGTH = 32;

/** File name limits (SPEC §14.4). */
export const NAME_MAX_UTF8_BYTES = 255;

/** Max JSON request body accepted by API routes. */
export const JSON_BODY_MAX_BYTES = 64 * KIB;

export const QUEUE_NAMES = ['scan', 'archive', 'compress', 'notify', 'cleanup'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** Cron expressions (UTC) — SPEC §13.4. */
export const CRON = {
  /** 00:05 WIB */
  dailyAds: '5 17 * * *',
  hourly: '0 * * * *',
  /** 02:00 WIB */
  nightly: '0 19 * * *',
  /**
   * Workers Free allows 5 cron triggers per account: one hourly trigger runs the hourly tasks and,
   * in their UTC hour, the daily ones (ADR-035).
   */
  combined: '5 * * * *',
} as const;

export const TIMEZONE = 'Asia/Jakarta';
export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The operator's address: alerts go there, and so do people who want to advertise (ADR-041). */
export const OPERATOR_EMAIL = 'admin@zeiko.biz.id';
export const AD_CONTACT = OPERATOR_EMAIL;

/** Requests a minute one access token may make on /api/v1 (ADR-061): RL_API in wrangler.jsonc. */
export const API_RATE_PER_MINUTE = 300;
