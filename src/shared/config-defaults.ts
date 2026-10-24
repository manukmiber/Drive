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
  upload_part_concurrency: int().min(1).max(16).default(4),
  upload_max_parallel_files: int().min(1).max(10).default(3),
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

  // ── Zeiko S3 (ADR-044) ──
  s3_max_buckets_per_account: int().min(1).default(100),
  s3_max_keys_per_account: int().min(1).default(10),
  s3_max_open_uploads_per_account: int().min(1).default(1000),
  /** Unfinished multipart uploads are dropped after this (R2 itself aborts them after 7 days). */
  s3_multipart_ttl_hours: int().min(1).max(167).default(144),
  /** D1 queries one listing may spend skipping folders (Workers Free allows 50 per request). */
  s3_list_max_queries: int().min(2).max(40).default(10),

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
      virustotal_hash_lookup: z.boolean(),
      ads: z.boolean(),
    })
    .default({
      whatsapp_cloud_api: false,
      telegram_bot: true,
      email_share: true,
      csam_scan: false,
      virustotal_hash_lookup: false,
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
  'share_default_expiry_days',
  'share_expiry_choices_hours',
  'share_message_max_chars',
  'share_email_max_recipients',
  'zstd_levels',
  'zip_deflate_stream_max_bytes',
  'standalone_compress_max_bytes',
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
] as const satisfies readonly ConfigKey[];
