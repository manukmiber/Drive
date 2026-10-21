// Enum-like values shared by the Worker, the web app and the DB schema.
// The DB stores them as TEXT without CHECK so new values can be added (SPEC §17).

export const USER_ROLES = ['user', 'moderator', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'suspended', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PLAN_KINDS = ['personal', 'family'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

export const POOL_OWNER_TYPES = ['user', 'family'] as const;
export type PoolOwnerType = (typeof POOL_OWNER_TYPES)[number];

export const SUBSCRIPTION_STATUSES = [
  'active',
  'grace',
  'readonly',
  'suspended',
  'deleted',
  'cancelled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SPACES = ['personal', 'family'] as const;
export type Space = (typeof SPACES)[number];

export const NODE_KINDS = ['file', 'folder'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_STATUSES = ['uploading', 'scanning', 'ready', 'rejected'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const SCAN_STATUSES = ['pending', 'clean', 'infected', 'skipped', 'error'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const UPLOAD_STATUSES = ['active', 'completed', 'aborted', 'expired'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const SHARE_KINDS = ['file', 'bundle', 'folder'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export const SHARE_CHANNELS = ['qr', 'whatsapp', 'telegram', 'email', 'copy', 'webshare'] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export const SHARE_SEND_MODES = ['deeplink', 'bot', 'api'] as const;
export type ShareSendMode = (typeof SHARE_SEND_MODES)[number];

export const FAMILY_ROLES = ['owner', 'member'] as const;
export type FamilyRole = (typeof FAMILY_ROLES)[number];

export const ARCHIVE_FORMATS = ['zip_store', 'zip_deflate', 'tar_zst'] as const;
export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number];

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'expired', 'skipped'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const COMPRESS_KINDS = ['image', 'video'] as const;
export type CompressKind = (typeof COMPRESS_KINDS)[number];

export const COMPRESS_ENGINES = ['images', 'media', 'ffmpeg'] as const;
export type CompressEngine = (typeof COMPRESS_ENGINES)[number];

export const CREDIT_SOURCES = ['plan', 'pack', 'refund', 'usage', 'adjust'] as const;
export type CreditSource = (typeof CREDIT_SOURCES)[number];

export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'expired', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_PURPOSES = ['topup', 'direct'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const INVOICE_STATUSES = ['issued', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const AD_AREA_LEVELS = ['national', 'province', 'regency'] as const;
export type AdAreaLevel = (typeof AD_AREA_LEVELS)[number];

export const AD_TIERS = ['tier1', 'tier2', 'tier3', 'province', 'national'] as const;
export type AdTier = (typeof AD_TIERS)[number];

export const AD_PLACEMENTS = ['explorer_sidebar', 'share_page'] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];

export const ADVERTISER_KINDS = ['umkm', 'mahasiswa', 'lainnya'] as const;
export type AdvertiserKind = (typeof ADVERTISER_KINDS)[number];

export const AD_CTA_TYPES = [
  'web',
  'whatsapp',
  'instagram',
  'tiktok',
  'shopee',
  'tokopedia',
] as const;
export type AdCtaType = (typeof AD_CTA_TYPES)[number];

export const AD_CREATIVE_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'suspended',
] as const;
export type AdCreativeStatus = (typeof AD_CREATIVE_STATUSES)[number];

export const AD_BOOKING_STATUSES = [
  'held',
  'paid',
  'live',
  'completed',
  'refunded',
  'cancelled',
] as const;
export type AdBookingStatus = (typeof AD_BOOKING_STATUSES)[number];

export const REPORT_TARGETS = ['share', 'node', 'blob', 'ad', 'user'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

export const REPORT_PRIORITIES = ['urgent', 'normal'] as const;
export type ReportPriority = (typeof REPORT_PRIORITIES)[number];

export const REPORT_STATUSES = ['open', 'in_review', 'resolved', 'rejected'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const NOTIFY_CHANNELS = ['inapp', 'email', 'telegram'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];
