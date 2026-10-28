// Registry of every business number (SPEC §0.2: nothing hard-coded). Each top-level key is one
// row in `app_config` (value_json). Missing/invalid rows fall back to these defaults.
// Lampiran B values are the cost assumptions from the pricing spreadsheet.
import { z } from 'zod';
import { GIB, MIB } from './constants';

const int = () => z.number().int();
const nonNeg = () => z.number().int().nonnegative();

export const configSchema = z.object({
  // ── Lampiran B: cost assumptions ──
  usd_idr_rate: z.number().positive().default(18_000),
  r2_storage_usd_per_gb_month: z.number().nonnegative().default(0.015),
  image_transform_usd_per_1000: z.number().nonnegative().default(0.5),
  video_transform_usd_per_1000: z.number().nonnegative().default(0.5),
  free_transforms_per_month: nonNeg().default(5_000),
  usage_scenarios_pct: z.array(z.number().nonnegative()).default([20, 50, 100]),
  /** Fixed monthly costs whatever the traffic (Workers Paid $5, …), for the profit figures. */
  fixed_costs_usd_per_month: z.number().nonnegative().default(5),
  // Other component tariffs (USD), filled from docs for the admin cost dashboard (SPEC §13.1).
  component_tariffs_usd: z
    .object({
      r2_class_a_per_million: z.number().nonnegative(),
      r2_class_b_per_million: z.number().nonnegative(),
      workers_requests_per_million: z.number().nonnegative(),
      workers_cpu_ms_per_million: z.number().nonnegative(),
      d1_rows_read_per_million: z.number().nonnegative(),
      d1_rows_written_per_million: z.number().nonnegative(),
      container_vcpu_second: z.number().nonnegative(),
      container_gib_second: z.number().nonnegative(),
    })
    .default({
      r2_class_a_per_million: 4.5,
      r2_class_b_per_million: 0.36,
      workers_requests_per_million: 0.3,
      workers_cpu_ms_per_million: 0.02,
      d1_rows_read_per_million: 0.001,
      d1_rows_written_per_million: 1,
      container_vcpu_second: 0.00002,
      container_gib_second: 0.0000025,
    }),
  /**
   * The rest of R2's price list (developers.cloudflare.com/r2/pricing, ADR-037) for the relay's
   * storage screen; Standard storage and Class A/B are the two keys above. The free tier is per
   * Cloudflare account and Standard only. Cloudflare's page does not say whether its GB is 10^9
   * or 2^30 bytes, so `gb_bytes` follows Drive's GB until a bill says otherwise.
   */
  r2_billing: z
    .object({
      gb_bytes: z.number().int().positive(),
      /** Day of the month the Cloudflare billing period starts (UTC). */
      cycle_start_day: z.number().int().min(1).max(28),
      free_storage_gb_month: z.number().nonnegative(),
      free_class_a: z.number().int().nonnegative(),
      free_class_b: z.number().int().nonnegative(),
      ia_storage_usd_per_gb_month: z.number().nonnegative(),
      ia_class_a_per_million: z.number().nonnegative(),
      ia_class_b_per_million: z.number().nonnegative(),
      ia_retrieval_usd_per_gb: z.number().nonnegative(),
    })
    .default({
      gb_bytes: GIB,
      cycle_start_day: 1,
      free_storage_gb_month: 10,
      free_class_a: 1_000_000,
      free_class_b: 10_000_000,
      ia_storage_usd_per_gb_month: 0.01,
      ia_class_a_per_million: 9,
      ia_class_b_per_million: 0.9,
      ia_retrieval_usd_per_gb: 0.01,
    }),

  // ── Upload / storage ──
  /** Defaults for a device that has not picked its own (ADR-053). */
  upload_part_concurrency: int().min(1).max(16).default(4),
  upload_max_parallel_files: int().min(1).max(20).default(3),
  /** The most a person may pick on their device (ADR-053; the owner's ceiling is 20 files). */
  upload_parallel_files_cap: int().min(1).max(20).default(20),
  upload_part_concurrency_cap: int().min(1).max(16).default(8),
  upload_expiry_hours: int().min(1).max(160).default(144),
  trash_retention_days: int().min(1).default(30),
  manifest_rebuild_min_interval_minutes: int().min(1).default(60),
  quota_reconcile_alert_bytes: nonNeg().default(0),

  // ── Download ──
  download_link_ttl_seconds: int()
    .min(60)
    .default(6 * 3600),
  download_edge_cache: z.boolean().default(false),
  download_edge_cache_max_bytes: nonNeg().default(256 * MIB),
  /** Files downloading at once in the app's download queue (ADR-053), default and ceiling. */
  download_max_parallel_files: int().min(1).max(20).default(3),
  download_parallel_files_cap: int().min(1).max(20).default(20),
  /** Files one "download separately" request may list (folders expanded). */
  download_plan_max_items: int().min(1).max(20_000).default(5_000),
  preview_link_ttl_seconds: int()
    .min(30)
    .default(15 * 60),
  preview_text_max_bytes: nonNeg().default(1 * MIB),

  // ── Share ──
  share_default_expiry_days: int().min(0).default(30),
  share_expiry_choices_hours: z.array(nonNeg()).default([1, 24, 168, 720, 0]),
  share_password_cookie_minutes: int().min(1).default(10),
  share_download_dedupe_minutes: int().min(1).default(10),
  share_email_max_recipients: int().min(1).default(5),
  share_email_daily_limit: int().min(0).default(20),
  share_message_max_chars: int().min(1).default(500),

  // ── Archive ──
  zip_deflate_stream_max_bytes: nonNeg().default(2 * GIB),
  zstd_levels: z
    .object({ fast: int(), normal: int(), max: int() })
    .default({ fast: 1, normal: 3, max: 12 }),
  archive_link_ttl_hours: int().min(1).default(24),
  archive_max_running_jobs_per_user: int().min(1).default(1),
  /** Async jobs (TAR.ZST, big deflate ZIP): input cap, bounded by the archiver's local disk. */
  archive_async_max_bytes: nonNeg().default(8 * GIB),
  archive_max_items: int().min(1).default(100_000),

  // ── Scan ──
  scan_max_bytes: nonNeg().default(512 * MIB),
  scan_max_attempts: int().min(1).default(3),
  /**
   * VirusTotal (ADR-046), on when the VIRUSTOTAL_API_KEY secret is set. Only risky types are looked
   * up by hash; with `upload`, executables and macro documents VirusTotal has never seen are sent
   * whole (≤ upload_max_bytes, its 32 MB direct-upload limit). The budget is the key's: a free
   * key gives 4 requests a minute and 500 a day. Past it, files go through without VirusTotal.
   */
  virustotal: z
    .object({
      enabled: z.boolean(),
      upload: z.boolean(),
      per_minute: int().min(1),
      per_day: int().min(1),
      /** One person's share of the day, so a folder of a thousand DLLs cannot use it all up. */
      per_user_day: int().min(1),
      /** Engines that must call a file malicious before it is rejected. */
      malicious_min: int().min(1),
      upload_max_bytes: nonNeg().max(32 * MIB),
      poll_seconds: int().min(15).max(3600),
      max_polls: int().min(1).max(100),
      /** Times a file waits for a free minute of budget before it goes through unchecked. */
      max_waits: int().min(0).max(200),
      cache_days: int().min(1),
    })
    .default({
      enabled: true,
      upload: true,
      per_minute: 4,
      per_day: 500,
      per_user_day: 50,
      malicious_min: 3,
      upload_max_bytes: 32 * MIB,
      poll_seconds: 60,
      max_polls: 10,
      max_waits: 30,
      cache_days: 30,
    }),

  // ── Access tokens (ADR-061) ──
  /** Working personal tokens one user may have. */
  api_tokens_max_per_user: int().min(1).max(100).default(20),
  // Zeiko's own apps signing in (OAuth 2.0 + PKCE, ADR-063).
  oauth_code_ttl_seconds: int().min(10).max(600).default(60),
  oauth_access_ttl_seconds: int().min(300).max(86_400).default(3_600),
  oauth_refresh_ttl_days: int().min(1).max(365).default(90),

  // ── Zeiko S3 (ADR-044) ──
  s3_max_buckets_per_account: int().min(1).default(100),
  s3_max_keys_per_account: int().min(1).default(10),
  s3_max_open_uploads_per_account: int().min(1).default(1000),
  /** Unfinished multipart uploads are dropped after this (R2 itself aborts them after 7 days). */
  s3_multipart_ttl_hours: int().min(1).max(167).default(144),
  /** D1 queries one listing may spend skipping folders (Workers Free allows 50 per request). */
  s3_list_max_queries: int().min(2).max(40).default(10),
  /** Uploads from the /s3 page go through the app in one request (ADR-055): under Workers' 100 MB body cap. */
  s3_web_upload_max_bytes: nonNeg()
    .max(100 * 1000 * 1000)
    .default(95 * MIB),
  /** Longest a "copy link" from the /s3 page lasts (S3's own limit is 7 days). */
  s3_link_max_seconds: int()
    .min(60)
    .max(7 * 24 * 3600)
    .default(7 * 24 * 3600),
  // Bucket statistics and access logs (ADR-060).
  /** Days of per-bucket request/egress counts kept. */
  s3_stats_keep_days: int().min(31).default(90),
  /** Access log lines not delivered (target full, unpaid, gone) are dropped after this. */
  s3_log_pending_days: int().min(1).default(7),
  /** Lines per delivered log object. */
  s3_log_lines_per_object: int().min(100).max(20_000).default(5_000),
  /** Buckets whose logs one hourly run delivers. */
  s3_log_buckets_per_run: int().min(1).max(50).default(10),
  // Lifecycle rules (ADR-072): expire objects, abort forgotten multipart uploads.
  /** Rules one bucket may have (Amazon allows 1,000). */
  s3_lifecycle_max_rules: int().min(1).max(1000).default(100),
  /** Buckets one hourly run works on (Workers Free: about 6 D1 queries each). */
  s3_lifecycle_buckets_per_run: int().min(1).max(10).default(2),
  /** Objects one bucket's turn looks at; the rest waits for the next run (a cursor). */
  s3_lifecycle_scan_rows: int().min(10).max(1000).default(200),
  // Paid upfront (ADR-047): a size in whole GB, 1 copy or 3 (in three R2 buckets), for a month.
  s3_price_idr_per_gb_month: nonNeg().default(500),
  s3_price_idr_per_gb_month_3x: nonNeg().default(1_250),
  s3_min_gb: int().min(1).default(3),
  s3_max_gb: int().min(1).default(5_000),
  /** Free egress per period; past it, per started block, added to the next renewal. */
  s3_egress_free_bytes: nonNeg().default(500 * GIB),
  s3_egress_block_bytes: int()
    .min(1)
    .default(500 * GIB),
  s3_egress_block_idr: nonNeg().default(5_000),
  // An address of the account's own (ADR-048), paid once and kept while the plan is renewed.
  /** s3.<name>.zeiko.biz.id */
  s3_url_zeiko_idr: nonNeg().default(3_000),
  /** The person's own domain, e.g. s3.tokobudi.com */
  s3_url_custom_idr: nonNeg().default(5_000),
  /** Days a plan may stay unpaid before its address is released (and has to be bought again). */
  s3_url_release_days: int().min(1).default(30),
  /** Days after a plan ran out: read-only (no uploads, no public links), locked, deleted. */
  s3_dunning: z
    .object({
      readonly_after_days: nonNeg(),
      lock_after_days: nonNeg(),
      delete_after_days: nonNeg(),
      notify_days_after: z.array(nonNeg()),
    })
    .default({
      readonly_after_days: 3,
      lock_after_days: 14,
      delete_after_days: 30,
      notify_days_after: [0, 3, 14, 29],
    }),

  // ── Billing ──
  /** Unused since ADR-041 (no top-ups); kept so a stored config still reads. */
  min_topup_idr: nonNeg().default(10_000),
  payment_methods: z
    .array(
      z.object({
        code: z.string(),
        label: z.string(),
        min_idr: nonNeg(),
        fee_flat_idr: nonNeg(),
        fee_pct: z.number().nonnegative(),
        active: z.boolean(),
      }),
    )
    .default([
      // Zeiko Accounts (ADR-036): QRIS, checked by the operator. Drive takes QRIS only (ADR-038);
      // another code here is never offered (services/billing.ts::DRIVE_METHODS). Every purchase is
      // paid on its own (ADR-041), so the minimum is low: a Mini plan is Rp1.000.
      { code: 'qris', label: 'QRIS', min_idr: 1_000, fee_flat_idr: 0, fee_pct: 0.7, active: true },
    ]),
  tax_rate_pct: z.number().nonnegative().default(0),
  billing_reminder_days_before: z.array(nonNeg()).default([3, 1]),
  dunning: z
    .object({
      readonly_after_days: nonNeg(),
      suspend_after_days: nonNeg(),
      delete_after_days: nonNeg(),
      notify_days_after: z.array(nonNeg()),
    })
    .default({
      readonly_after_days: 3,
      suspend_after_days: 30,
      delete_after_days: 37,
      notify_days_after: [0, 3, 14, 25, 29, 36],
    }),
  upgrade_ratio_hint_pct: int().min(1).max(100).default(90),
  /** H+delete: 'dry_run' only logs what would be deleted; switch to 'live' from admin (ADR-026). */
  dunning_delete_mode: z.enum(['dry_run', 'live']).default('dry_run'),
  /** Who bears gateway fees on top-ups. Default: Zeiko (fee recorded for the cost dashboard). */
  payment_fee_paid_by: z.enum(['zeiko', 'user']).default('zeiko'),
  pending_payment_ttl_minutes: int().min(5).default(60),

  // ── Family ──
  family_join_convert_prorata: z.boolean().default(true),
  family_switch_cooldown_months: nonNeg().default(12),
  family_leave_readonly_days: nonNeg().default(30),
  family_invite_ttl_days: int().min(1).default(7),

  // ── Compress ──
  compress_pack_ttl_days: int().min(1).default(90),
  long_video_credits_per_minute: int().min(1).default(1),
  images_binding_max_input_bytes: nonNeg().default(20_000_000),
  media_binding_max_input_bytes: nonNeg().default(99_000_000),
  media_binding_max_seconds: int().min(1).default(60),
  standalone_compress_max_bytes: nonNeg().default(2 * GIB),

  // ── Editors (ADR-050, ADR-051): everything runs in the person's browser, in its memory ──
  editor_image_max_bytes: nonNeg().default(50 * MIB),
  editor_video_max_bytes: nonNeg().default(1 * GIB),
  editor_pdf_max_bytes: nonNeg().default(200 * MIB),
  editor_text_max_bytes: nonNeg().default(5 * MIB),
  editor_doc_max_bytes: nonNeg().default(50 * MIB),
  editor_sheet_max_bytes: nonNeg().default(30 * MIB),
  editor_zip_max_bytes: nonNeg().default(500 * MIB),
  /** All the files taken out of one ZIP together (a ZIP bomb stops here). */
  editor_zip_extract_max_bytes: nonNeg().default(1 * GIB),

  // ── Ads (ADR-043: campaigns, no slots, a 15-second rotation) ──
  /** A day in one city; two cities are two of these, up to one bundle. */
  ad_price_city_idr: nonNeg().default(1_000),
  /** A day in up to `ad_bundle_cities` cities. */
  ad_price_bundle_idr: nonNeg().default(3_000),
  ad_bundle_cities: int().min(1).default(10),
  /** A day everywhere in Indonesia; no city campaign costs more than this. */
  ad_price_national_idr: nonNeg().default(10_000),
  /** Seconds one ad stays in the card before the next one. */
  ad_rotate_seconds: int().min(5).max(300).default(15),
  /** Rotation turns an UMKM/small business or student advertiser gets for one of anyone else's. */
  ad_priority_weight: int().min(1).max(10).default(2),
  /** How far ahead a campaign may start, and how long it may run. */
  ad_campaign_lead_days: int().min(0).default(60),
  ad_campaign_max_days: int().min(1).default(90),
  ad_candidates_cache_seconds: int().min(1).default(60),
  ad_moderation_sla_hours: int().min(1).default(24),
  ad_refund_on_suspend: z.object({ severe: z.boolean(), other: z.boolean() }).default({
    severe: false,
    other: true,
  }),
  ad_image_max_bytes: nonNeg().default(200 * 1024),
  /** Unused since ADR-043 (no slots, holds, per-session cap or student discount); kept so a
   *  stored config still reads. */
  ad_inventory_days_ahead: int().min(1).default(14),
  ad_slots_by_tier: z
    .object({
      tier1: nonNeg(),
      tier2: nonNeg(),
      tier3: nonNeg(),
      province: nonNeg(),
      national: nonNeg(),
    })
    .default({ tier1: 8, tier2: 4, tier3: 4, province: 6, national: 3 }),
  ad_hold_minutes: int().min(1).default(15),
  ad_student_discount_pct: int().min(0).max(100).default(50),
  ad_frequency_cap_per_session: int().min(1).default(3),

  // ── Moderation / privacy ──
  takedown_sla_hours: z.object({ urgent: int().min(1), normal: int().min(1) }).default({
    urgent: 4,
    normal: 24,
  }),
  log_retention_days: int().min(1).default(90),
  account_delete_wait_days: int().min(0).default(7),

  // ── Feature flags ──
  features: z
    .object({
      whatsapp_cloud_api: z.boolean(),
      telegram_bot: z.boolean(),
      email_share: z.boolean(),
      csam_scan: z.boolean(),
      ads: z.boolean(),
    })
    .default({
      whatsapp_cloud_api: false,
      telegram_bot: true,
      email_share: true,
      csam_scan: false,
      ads: true,
    }),
});

export type AppConfig = z.infer<typeof configSchema>;
export type ConfigKey = keyof AppConfig;

export const CONFIG_DEFAULTS: AppConfig = configSchema.parse({});

/** Keys exposed to unauthenticated clients (no cost data, no internals). */
export const PUBLIC_CONFIG_KEYS = [
  'upload_part_concurrency',
  'upload_max_parallel_files',
  'upload_parallel_files_cap',
  'upload_part_concurrency_cap',
  'download_max_parallel_files',
  'download_parallel_files_cap',
  'share_default_expiry_days',
  'share_expiry_choices_hours',
  'share_message_max_chars',
  'share_email_max_recipients',
  'zstd_levels',
  'zip_deflate_stream_max_bytes',
  'standalone_compress_max_bytes',
  'editor_image_max_bytes',
  'editor_video_max_bytes',
  'editor_pdf_max_bytes',
  'editor_text_max_bytes',
  'editor_doc_max_bytes',
  'editor_sheet_max_bytes',
  'editor_zip_max_bytes',
  'editor_zip_extract_max_bytes',
  'min_topup_idr',
  'upgrade_ratio_hint_pct',
  'ad_image_max_bytes',
  'ad_rotate_seconds',
  'ad_price_city_idr',
  'ad_price_bundle_idr',
  'ad_bundle_cities',
  'ad_price_national_idr',
  'tax_rate_pct',
  'features',
  // Zeiko S3's prices, for the website's S3 section (ADR-047/048/049).
  's3_price_idr_per_gb_month',
  's3_price_idr_per_gb_month_3x',
  's3_min_gb',
  's3_egress_free_bytes',
  's3_egress_block_bytes',
  's3_egress_block_idr',
  's3_url_zeiko_idr',
  's3_url_custom_idr',
  's3_web_upload_max_bytes',
  's3_link_max_seconds',
] as const satisfies readonly ConfigKey[];
