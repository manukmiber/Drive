// Drizzle mirror of migrations/0001_init.sql (ADR-011). Column names must match the SQL exactly;
// tests/integration/schema.test.ts compares both.
//
// Auth tables (and `users`) use Date-valued timestamps because Better Auth reads/writes Date objects.
// Every other table uses plain integer milliseconds (ADR-008).
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
import {
  AD_AREA_LEVELS,
  AD_BOOKING_STATUSES,
  AD_CAMPAIGN_SCOPES,
  AD_CAMPAIGN_STATUSES,
  AD_CREATIVE_STATUSES,
  AD_CTA_TYPES,
  AD_PLACEMENTS,
  AD_TIERS,
  ADVERTISER_KINDS,
  ARCHIVE_FORMATS,
  COMPRESS_ENGINES,
  COMPRESS_KINDS,
  CREDIT_SOURCES,
  FAMILY_ROLES,
  INVOICE_STATUSES,
  JOB_STATUSES,
  NODE_KINDS,
  NODE_STATUSES,
  NOTIFY_CHANNELS,
  PAYMENT_PURPOSES,
  PAYMENT_STATUSES,
  PLAN_KINDS,
  POOL_OWNER_TYPES,
  REPORT_PRIORITIES,
  REPORT_STATUSES,
  REPORT_TARGETS,
  SCAN_STATUSES,
  SHARE_CHANNELS,
  SHARE_KINDS,
  SHARE_SEND_MODES,
  SPACES,
  SUBSCRIPTION_STATUSES,
  UPLOAD_STATUSES,
  USER_ROLES,
  USER_STATUSES,
} from '../../shared/enums';

const date = (name: string) => integer(name, { mode: 'timestamp_ms' });
const bool = (name: string) => integer(name, { mode: 'boolean' });
const ms = (name: string) => integer(name);

// ───────────────────────────── Users & auth ─────────────────────────────
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  emailVerified: bool('email_verified').notNull().default(false),
  name: text('name').notNull().default(''),
  image: text('avatar_url'),
  adCityCode: text('ad_city_code'),
  /** From the Zeiko Account at sign-in (ADR-041); `adCityCode` is the matched area. */
  adCity: text('ad_city'),
  adPostalCode: text('ad_postal_code'),
  role: text('role', { enum: USER_ROLES }).notNull().default('user'),
  status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
  twoFactorEnabled: bool('two_factor_enabled').notNull().default(false),
  deleteRequestedAt: ms('delete_requested_at'),
  /** UI and email language (ADR-036). */
  locale: text('locale', { enum: ['id', 'en'] })
    .notNull()
    .default('id'),
  createdAt: date('created_at').notNull(),
  updatedAt: date('updated_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  token: text('token').notNull(),
  expiresAt: date('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: date('created_at').notNull(),
  updatedAt: date('updated_at').notNull(),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: date('access_token_expires_at'),
  refreshTokenExpiresAt: date('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: date('created_at').notNull(),
  updatedAt: date('updated_at').notNull(),
});

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: date('expires_at').notNull(),
  createdAt: date('created_at').notNull(),
  updatedAt: date('updated_at').notNull(),
});

export const passkeys = sqliteTable('passkeys', {
  id: text('id').primaryKey(),
  name: text('name'),
  publicKey: text('public_key').notNull(),
  userId: text('user_id').notNull(),
  credentialID: text('credential_id').notNull(),
  counter: integer('counter').notNull().default(0),
  deviceType: text('device_type').notNull(),
  backedUp: bool('backed_up').notNull().default(false),
  transports: text('transports'),
  aaguid: text('aaguid'),
  createdAt: date('created_at'),
});

export const twoFactors = sqliteTable('two_factors', {
  id: text('id').primaryKey(),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  userId: text('user_id').notNull(),
  verified: bool('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: date('locked_until'),
});

// ───────────────────────────── Config & catalog ─────────────────────────────
export const appConfig = sqliteTable('app_config', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: ms('updated_at').notNull(),
});

export const plans = sqliteTable('plans', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: PLAN_KINDS }).notNull(),
  priceIdr: integer('price_idr').notNull(),
  storageBytes: integer('storage_bytes').notNull(),
  compressQuota: integer('compress_quota').notNull().default(0),
  maxMembers: integer('max_members').notNull().default(1),
  maxFileBytes: integer('max_file_bytes').notNull(),
  showAds: bool('show_ads').notNull().default(true),
  active: bool('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
});

export const addons = sqliteTable('addons', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  priceIdr: integer('price_idr').notNull(),
  storageBytes: integer('storage_bytes').notNull(),
  active: bool('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
});

export const compressPacks = sqliteTable('compress_packs', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  priceIdr: integer('price_idr').notNull(),
  credits: integer('credits').notNull(),
  ttlDays: integer('ttl_days').notNull(),
  active: bool('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
});

export const counters = sqliteTable('counters', {
  name: text('name').primaryKey(),
  value: integer('value').notNull().default(0),
});

export const usageCounters = sqliteTable('usage_counters', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  windowStart: ms('window_start').notNull(),
  expiresAt: ms('expires_at').notNull(),
});

// ───────────────────────────── Storage pools & billing ─────────────────────────────
export const storagePools = sqliteTable('storage_pools', {
  id: text('id').primaryKey(),
  ownerType: text('owner_type', { enum: POOL_OWNER_TYPES }).notNull(),
  ownerId: text('owner_id').notNull(),
  limitBytes: integer('limit_bytes').notNull().default(0),
  usedBytes: integer('used_bytes').notNull().default(0),
  reservedBytes: integer('reserved_bytes').notNull().default(0),
  bonusBytes: integer('bonus_bytes').notNull().default(0),
  updatedAt: ms('updated_at').notNull(),
});

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  poolId: text('pool_id').notNull(),
  payerUserId: text('payer_user_id').notNull(),
  planCode: text('plan_code').notNull(),
  nextPlanCode: text('next_plan_code'),
  status: text('status', { enum: SUBSCRIPTION_STATUSES }).notNull(),
  periodStart: ms('period_start').notNull(),
  periodEnd: ms('period_end').notNull(),
  anchorDay: integer('anchor_day').notNull(),
  autoRenew: bool('auto_renew').notNull().default(true),
  cancelAtPeriodEnd: bool('cancel_at_period_end').notNull().default(false),
  statusChangedAt: ms('status_changed_at').notNull(),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const subscriptionAddons = sqliteTable('subscription_addons', {
  id: text('id').primaryKey(),
  subscriptionId: text('subscription_id').notNull(),
  addonCode: text('addon_code').notNull(),
  qty: integer('qty').notNull().default(1),
  cancelAtPeriodEnd: bool('cancel_at_period_end').notNull().default(false),
  startsAt: ms('starts_at').notNull(),
  endsAt: ms('ends_at'),
});

export const wallets = sqliteTable('wallets', {
  userId: text('user_id').primaryKey(),
  balanceIdr: integer('balance_idr').notNull().default(0),
  updatedAt: ms('updated_at').notNull(),
});

export const walletLedger = sqliteTable('wallet_ledger', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  deltaIdr: integer('delta_idr').notNull(),
  balanceAfter: integer('balance_after').notNull(),
  reason: text('reason').notNull(),
  ref: text('ref'),
  createdAt: ms('created_at').notNull(),
});

export const payments = sqliteTable('payments', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  providerRef: text('provider_ref').notNull(),
  method: text('method').notNull(),
  amountIdr: integer('amount_idr').notNull(),
  feeIdr: integer('fee_idr').notNull().default(0),
  status: text('status', { enum: PAYMENT_STATUSES }).notNull(),
  purpose: text('purpose', { enum: PAYMENT_PURPOSES }).notNull(),
  purposeRef: text('purpose_ref'),
  rawJson: text('raw_json'),
  createdAt: ms('created_at').notNull(),
  paidAt: ms('paid_at'),
  updatedAt: ms('updated_at').notNull(),
});

export const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
  number: text('number').notNull(),
  userId: text('user_id').notNull(),
  linesJson: text('lines_json').notNull(),
  subtotalIdr: integer('subtotal_idr').notNull(),
  taxIdr: integer('tax_idr').notNull().default(0),
  totalIdr: integer('total_idr').notNull(),
  status: text('status', { enum: INVOICE_STATUSES }).notNull(),
  paymentId: text('payment_id'),
  issuedAt: ms('issued_at').notNull(),
});

export const creditLedger = sqliteTable('credit_ledger', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  delta: integer('delta').notNull(),
  remaining: integer('remaining').notNull().default(0),
  source: text('source', { enum: CREDIT_SOURCES }).notNull(),
  ref: text('ref'),
  expiresAt: ms('expires_at'),
  createdAt: ms('created_at').notNull(),
});

// ───────────────────────────── Families ─────────────────────────────
export const families = sqliteTable('families', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  poolId: text('pool_id').notNull(),
  name: text('name').notNull(),
  createdAt: ms('created_at').notNull(),
});

export const familyMembers = sqliteTable(
  'family_members',
  {
    familyId: text('family_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role', { enum: FAMILY_ROLES }).notNull(),
    capBytes: integer('cap_bytes'),
    usedBytes: integer('used_bytes').notNull().default(0),
    reservedBytes: integer('reserved_bytes').notNull().default(0),
    joinedAt: ms('joined_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.familyId, t.userId] })],
);

export const familyInvites = sqliteTable('family_invites', {
  id: text('id').primaryKey(),
  familyId: text('family_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  invitedBy: text('invited_by').notNull(),
  channel: text('channel').notNull(),
  expiresAt: ms('expires_at').notNull(),
  acceptedBy: text('accepted_by'),
  acceptedAt: ms('accepted_at'),
  revokedAt: ms('revoked_at'),
  createdAt: ms('created_at').notNull(),
});

// ───────────────────────────── Files ─────────────────────────────
export const blobs = sqliteTable('blobs', {
  id: text('id').primaryKey(),
  poolId: text('pool_id').notNull(),
  r2Key: text('r2_key').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256'),
  crc32: integer('crc32'),
  sniffedMime: text('sniffed_mime'),
  uploaderId: text('uploader_id').notNull(),
  refcount: integer('refcount').notNull().default(1),
  scanStatus: text('scan_status', { enum: SCAN_STATUSES }).notNull().default('pending'),
  scanDetail: text('scan_detail'),
  scanAttempts: integer('scan_attempts').notNull().default(0),
  scannedAt: ms('scanned_at'),
  thumbKey: text('thumb_key'),
  createdAt: ms('created_at').notNull(),
});

export const nodes = sqliteTable('nodes', {
  rid: integer('rid').primaryKey(),
  id: text('id').notNull(),
  poolId: text('pool_id').notNull(),
  space: text('space', { enum: SPACES }).notNull(),
  familyId: text('family_id'),
  ownerId: text('owner_id').notNull(),
  createdBy: text('created_by').notNull(),
  parentId: text('parent_id'),
  kind: text('kind', { enum: NODE_KINDS }).notNull(),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull(),
  blobId: text('blob_id'),
  size: integer('size').notNull().default(0),
  mime: text('mime'),
  familyCanEdit: bool('family_can_edit').notNull().default(false),
  status: text('status', { enum: NODE_STATUSES }).notNull().default('ready'),
  trashedAt: ms('trashed_at'),
  trashedBy: text('trashed_by'),
  trashRootId: text('trash_root_id'),
  purgeAt: ms('purge_at'),
  clientModifiedAt: ms('client_modified_at'),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
  version: integer('version').notNull().default(1),
});

export const nodeStars = sqliteTable(
  'node_stars',
  {
    userId: text('user_id').notNull(),
    nodeId: text('node_id').notNull(),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.nodeId] })],
);

export const nodeRecent = sqliteTable(
  'node_recent',
  {
    userId: text('user_id').notNull(),
    nodeId: text('node_id').notNull(),
    accessedAt: ms('accessed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.nodeId] })],
);

export const uploads = sqliteTable('uploads', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  poolId: text('pool_id').notNull(),
  nodeId: text('node_id').notNull(),
  blobId: text('blob_id').notNull(),
  r2Key: text('r2_key').notNull(),
  r2UploadId: text('r2_upload_id'),
  size: integer('size').notNull(),
  partSize: integer('part_size').notNull(),
  totalParts: integer('total_parts').notNull(),
  reservedBytes: integer('reserved_bytes').notNull(),
  memberUserId: text('member_user_id'),
  onConflict: text('on_conflict', { enum: ['rename', 'replace'] })
    .notNull()
    .default('rename'),
  status: text('status', { enum: UPLOAD_STATUSES }).notNull(),
  expiresAt: ms('expires_at').notNull(),
  createdAt: ms('created_at').notNull(),
  completedAt: ms('completed_at'),
});

export const uploadParts = sqliteTable(
  'upload_parts',
  {
    uploadId: text('upload_id').notNull(),
    partNumber: integer('part_number').notNull(),
    etag: text('etag').notNull(),
    size: integer('size').notNull(),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.partNumber] })],
);

export const manifestDirty = sqliteTable('manifest_dirty', {
  userId: text('user_id').primaryKey(),
  dirtyAt: ms('dirty_at').notNull(),
});

// ───────────────────────────── Sharing ─────────────────────────────
export const shares = sqliteTable('shares', {
  id: text('id').primaryKey(),
  createdBy: text('created_by').notNull(),
  kind: text('kind', { enum: SHARE_KINDS }).notNull(),
  title: text('title').notNull(),
  expiresAt: ms('expires_at'),
  maxDownloads: integer('max_downloads'),
  downloadCount: integer('download_count').notNull().default(0),
  passwordHash: text('password_hash'),
  revokedAt: ms('revoked_at'),
  disabledReason: text('disabled_reason'),
  lastDownloadAt: ms('last_download_at'),
  createdAt: ms('created_at').notNull(),
  showListing: bool('show_listing').notNull(),
});

export const shareItems = sqliteTable(
  'share_items',
  {
    shareId: text('share_id').notNull(),
    nodeId: text('node_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.nodeId] })],
);

export const shareSends = sqliteTable('share_sends', {
  id: text('id').primaryKey(),
  shareId: text('share_id').notNull(),
  userId: text('user_id').notNull(),
  channel: text('channel', { enum: SHARE_CHANNELS }).notNull(),
  mode: text('mode', { enum: SHARE_SEND_MODES }).notNull(),
  recipientMasked: text('recipient_masked'),
  recipientHash: text('recipient_hash'),
  message: text('message'),
  status: text('status').notNull(),
  providerRef: text('provider_ref'),
  createdAt: ms('created_at').notNull(),
});

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  displayName: text('display_name').notNull(),
  channel: text('channel').notNull(),
  valueEncrypted: text('value_encrypted').notNull(),
  createdAt: ms('created_at').notNull(),
});

export const telegramLinks = sqliteTable('telegram_links', {
  userId: text('user_id').primaryKey(),
  tgUserId: text('tg_user_id').notNull(),
  chatId: text('chat_id').notNull(),
  usernameLower: text('username_lower'),
  allowReceive: bool('allow_receive').notNull().default(true),
  linkedAt: ms('linked_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const emailSuppressions = sqliteTable('email_suppressions', {
  emailHash: text('email_hash').primaryKey(),
  reason: text('reason').notNull(),
  createdAt: ms('created_at').notNull(),
});

// ───────────────────────────── Jobs ─────────────────────────────
export const archiveJobs = sqliteTable('archive_jobs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  nodeIdsJson: text('node_ids_json').notNull(),
  format: text('format', { enum: ARCHIVE_FORMATS }).notNull(),
  level: integer('level'),
  name: text('name'),
  status: text('status', { enum: JOB_STATUSES }).notNull(),
  progress: integer('progress').notNull().default(0),
  totalBytes: integer('total_bytes').notNull().default(0),
  outKey: text('out_key'),
  outBytes: integer('out_bytes'),
  expiresAt: ms('expires_at'),
  error: text('error'),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const compressJobs = sqliteTable('compress_jobs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  batchId: text('batch_id'),
  sourceNodeId: text('source_node_id'),
  sourceKey: text('source_key'),
  kind: text('kind', { enum: COMPRESS_KINDS }).notNull(),
  engine: text('engine', { enum: COMPRESS_ENGINES }).notNull(),
  optionsJson: text('options_json').notNull(),
  status: text('status', { enum: JOB_STATUSES }).notNull(),
  outNodeId: text('out_node_id'),
  outKey: text('out_key'),
  creditsUsed: integer('credits_used').notNull().default(0),
  savedBytes: integer('saved_bytes'),
  error: text('error'),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

// ───────────────────────────── Ads ─────────────────────────────
export const adAreas = sqliteTable('ad_areas', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  level: text('level', { enum: AD_AREA_LEVELS }).notNull(),
  parentCode: text('parent_code'),
  tier: text('tier', { enum: AD_TIERS }).notNull(),
  cfAliasesJson: text('cf_aliases_json').notNull().default('[]'),
});

export const adPrices = sqliteTable(
  'ad_prices',
  {
    areaLevel: text('area_level', { enum: AD_AREA_LEVELS }).notNull(),
    tier: text('tier', { enum: AD_TIERS }).notNull(),
    placement: text('placement', { enum: AD_PLACEMENTS }).notNull(),
    pricePerDayIdr: integer('price_per_day_idr').notNull(),
    active: bool('active').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.areaLevel, t.tier, t.placement] })],
);

export const adInventory = sqliteTable(
  'ad_inventory',
  {
    date: text('date').notNull(),
    areaCode: text('area_code').notNull(),
    placement: text('placement', { enum: AD_PLACEMENTS }).notNull(),
    totalSlots: integer('total_slots').notNull(),
    bookedSlots: integer('booked_slots').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.date, t.areaCode, t.placement] })],
);

export const advertisers = sqliteTable('advertisers', {
  userId: text('user_id').primaryKey(),
  businessName: text('business_name').notNull(),
  kind: text('kind', { enum: ADVERTISER_KINDS }).notNull(),
  studentVerified: bool('student_verified').notNull().default(false),
  studentEmail: text('student_email'),
  phone: text('phone').notNull(),
  createdAt: ms('created_at').notNull(),
});

export const adCreatives = sqliteTable('ad_creatives', {
  id: text('id').primaryKey(),
  advertiserId: text('advertiser_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  imageKey: text('image_key'),
  ctaType: text('cta_type', { enum: AD_CTA_TYPES }).notNull(),
  ctaValue: text('cta_value').notNull(),
  category: text('category').notNull(),
  status: text('status', { enum: AD_CREATIVE_STATUSES }).notNull(),
  rejectReason: text('reject_reason'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: ms('reviewed_at'),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const adBookings = sqliteTable('ad_bookings', {
  id: text('id').primaryKey(),
  creativeId: text('creative_id').notNull(),
  areaCode: text('area_code').notNull(),
  placement: text('placement', { enum: AD_PLACEMENTS }).notNull(),
  date: text('date').notNull(),
  priceIdr: integer('price_idr').notNull(),
  status: text('status', { enum: AD_BOOKING_STATUSES }).notNull(),
  holdExpiresAt: ms('hold_expires_at'),
  paymentId: text('payment_id'),
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

// ADR-043 (migrations/0006_ad_campaigns.sql): campaigns replace the per-day slot bookings above.
export const adCampaigns = sqliteTable('ad_campaigns', {
  id: text('id').primaryKey(),
  advertiserId: text('advertiser_id').notNull(),
  creativeId: text('creative_id').notNull(),
  scope: text('scope', { enum: AD_CAMPAIGN_SCOPES }).notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  days: integer('days').notNull(),
  pricePerDayIdr: integer('price_per_day_idr').notNull(),
  totalIdr: integer('total_idr').notNull(),
  status: text('status', { enum: AD_CAMPAIGN_STATUSES }).notNull(),
  reason: text('reason'),
  paymentId: text('payment_id'),
  payAmountIdr: integer('pay_amount_idr'),
  payQris: text('pay_qris'),
  payUrl: text('pay_url'),
  createdBy: text('created_by').notNull(),
  paidAt: ms('paid_at'),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const adCampaignAreas = sqliteTable(
  'ad_campaign_areas',
  {
    campaignId: text('campaign_id').notNull(),
    areaCode: text('area_code').notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.areaCode] })],
);

export const adCampaignStats = sqliteTable(
  'ad_campaign_stats',
  {
    campaignId: text('campaign_id').notNull(),
    date: text('date').notNull(),
    areaCode: text('area_code').notNull(),
    impressions: integer('impressions').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.date, t.areaCode] })],
);

// ───────────────────────────── Moderation & compliance ─────────────────────────────
export const abuseReports = sqliteTable('abuse_reports', {
  id: text('id').primaryKey(),
  targetType: text('target_type', { enum: REPORT_TARGETS }).notNull(),
  targetId: text('target_id').notNull(),
  category: text('category').notNull(),
  priority: text('priority', { enum: REPORT_PRIORITIES }).notNull(),
  reporterUserId: text('reporter_user_id'),
  reporterContact: text('reporter_contact'),
  details: text('details'),
  status: text('status', { enum: REPORT_STATUSES }).notNull(),
  slaDueAt: ms('sla_due_at').notNull(),
  resolvedBy: text('resolved_by'),
  resolvedAt: ms('resolved_at'),
  action: text('action'),
  createdAt: ms('created_at').notNull(),
});

export const blockedHashes = sqliteTable('blocked_hashes', {
  sha256: text('sha256').primaryKey(),
  reason: text('reason').notNull(),
  createdBy: text('created_by'),
  createdAt: ms('created_at').notNull(),
});

export const legalHolds = sqliteTable('legal_holds', {
  blobId: text('blob_id').primaryKey(),
  reason: text('reason').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: ms('created_at').notNull(),
});

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  type: text('type').notNull(),
  payloadJson: text('payload_json').notNull(),
  readAt: ms('read_at'),
  createdAt: ms('created_at').notNull(),
});

export const notificationPrefs = sqliteTable(
  'notification_prefs',
  {
    userId: text('user_id').notNull(),
    type: text('type').notNull(),
    channel: text('channel', { enum: NOTIFY_CHANNELS }).notNull(),
    enabled: bool('enabled').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.type, t.channel] })],
);

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  ipHash: text('ip_hash'),
  metaJson: text('meta_json'),
  createdAt: ms('created_at').notNull(),
});

// ───────────────────────────── Zeiko S3 (ADR-044, migrations/0007_s3.sql) ─────────────────────────────
// The object index itself is per account (services/s3-index.ts) and not part of this schema.
export const s3Accounts = sqliteTable('s3_accounts', {
  userId: text('user_id').primaryKey(),
  status: text('status', { enum: ['active', 'suspended', 'deleting'] }).notNull(),
  limitBytes: integer('limit_bytes').notNull(),
  usedBytes: integer('used_bytes').notNull(),
  reservedBytes: integer('reserved_bytes').notNull(),
  indexBinding: text('index_binding'),
  sweptAt: ms('swept_at').notNull(),
  billingState: text('billing_state', { enum: ['ok', 'readonly', 'locked'] }).notNull(),
  createdBy: text('created_by'),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const s3Keys = sqliteTable('s3_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  label: text('label').notNull(),
  secretEnc: text('secret_enc').notNull(),
  createdAt: ms('created_at').notNull(),
  lastUsedAt: ms('last_used_at'),
  revokedAt: ms('revoked_at'),
});

export const s3Buckets = sqliteTable('s3_buckets', {
  name: text('name').primaryKey(),
  userId: text('user_id').notNull(),
  public: bool('public').notNull(),
  blockedAt: ms('blocked_at'),
  createdAt: ms('created_at').notNull(),
});

export const s3Subscriptions = sqliteTable('s3_subscriptions', {
  userId: text('user_id').primaryKey(),
  gb: integer('gb').notNull(),
  replicas: integer('replicas').notNull(),
  nextGb: integer('next_gb'),
  nextReplicas: integer('next_replicas'),
  anchorDay: integer('anchor_day').notNull(),
  periodStart: ms('period_start').notNull(),
  periodEnd: ms('period_end').notNull(),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const s3Usage = sqliteTable(
  's3_usage',
  {
    userId: text('user_id').notNull(),
    periodStart: ms('period_start').notNull(),
    billable: bool('billable').notNull(),
    egressBytes: integer('egress_bytes').notNull(),
    billedBlocks: integer('billed_blocks').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.periodStart] })],
);

export const s3Urls = sqliteTable('s3_urls', {
  hostname: text('hostname').primaryKey(),
  userId: text('user_id').notNull(),
  kind: text('kind', { enum: ['zeiko', 'custom'] }).notNull(),
  status: text('status', { enum: ['reserved', 'pending', 'active', 'failed'] }).notNull(),
  cfId: text('cf_id'),
  cfRouteId: text('cf_route_id'),
  recordsJson: text('records_json'),
  error: text('error'),
  priceIdr: integer('price_idr').notNull(),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

export const vtVerdicts = sqliteTable('vt_verdicts', {
  sha256: text('sha256').primaryKey(),
  verdict: text('verdict', { enum: ['malicious', 'clean', 'unknown'] }).notNull(),
  malicious: integer('malicious').notNull(),
  engines: integer('engines').notNull(),
  label: text('label'),
  uploaded: bool('uploaded').notNull(),
  checkedAt: ms('checked_at').notNull(),
});

export const vtBudget = sqliteTable('vt_budget', {
  slot: text('slot').primaryKey(),
  used: integer('used').notNull(),
  expiresAt: ms('expires_at').notNull(),
});

export type NodeRow = typeof nodes.$inferSelect;
export type BlobRow = typeof blobs.$inferSelect;
export type PoolRow = typeof storagePools.$inferSelect;
export type UploadRow = typeof uploads.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
