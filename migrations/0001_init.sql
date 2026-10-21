-- Zeiko Cloud Storage — initial schema (SPEC §4).
-- Conventions (DECISIONS.md): times = INTEGER ms since epoch (UTC); money = INTEGER Rupiah;
-- sizes = INTEGER bytes; booleans = INTEGER 0/1. Enum-like columns are validated in TypeScript,
-- not with CHECK, so new values (e.g. nodes.kind) can be added without a table rebuild.
-- CHECK constraints are used only for hard invariants (non-negative counters, slot caps).

-- ───────────────────────────── Users & auth (Better Auth) ─────────────────────────────
CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  name                TEXT NOT NULL DEFAULT '',
  avatar_url          TEXT,
  ad_city_code        TEXT,
  role                TEXT NOT NULL DEFAULT 'user',      -- user | moderator | admin
  status              TEXT NOT NULL DEFAULT 'active',    -- active | suspended | deleted
  two_factor_enabled  INTEGER NOT NULL DEFAULT 0,
  delete_requested_at INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_email_uq ON users (email);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX sessions_token_uq ON sessions (token);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE accounts (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id                TEXT NOT NULL,
  provider_id               TEXT NOT NULL,
  access_token              TEXT,
  refresh_token             TEXT,
  id_token                  TEXT,
  access_token_expires_at   INTEGER,
  refresh_token_expires_at  INTEGER,
  scope                     TEXT,
  password                  TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);
CREATE INDEX accounts_user_idx ON accounts (user_id);
CREATE UNIQUE INDEX accounts_provider_uq ON accounts (provider_id, account_id);

CREATE TABLE verifications (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,
  value       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX verifications_identifier_idx ON verifications (identifier);

CREATE TABLE passkeys (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  public_key     TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL,
  counter        INTEGER NOT NULL DEFAULT 0,
  device_type    TEXT NOT NULL,
  backed_up      INTEGER NOT NULL DEFAULT 0,
  transports     TEXT,
  aaguid         TEXT,
  created_at     INTEGER
);
CREATE INDEX passkeys_user_idx ON passkeys (user_id);
CREATE UNIQUE INDEX passkeys_credential_uq ON passkeys (credential_id);

CREATE TABLE two_factors (
  id                         TEXT PRIMARY KEY,
  secret                     TEXT NOT NULL,
  backup_codes               TEXT NOT NULL,
  user_id                    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  verified                   INTEGER NOT NULL DEFAULT 1,
  failed_verification_count  INTEGER NOT NULL DEFAULT 0,
  locked_until               INTEGER
);
CREATE INDEX two_factors_user_idx ON two_factors (user_id);

-- ───────────────────────────── Config & catalog ─────────────────────────────
CREATE TABLE app_config (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE plans (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,                -- personal | family
  price_idr       INTEGER NOT NULL,
  storage_bytes   INTEGER NOT NULL,
  compress_quota  INTEGER NOT NULL DEFAULT 0,
  max_members     INTEGER NOT NULL DEFAULT 1,
  max_file_bytes  INTEGER NOT NULL,
  show_ads        INTEGER NOT NULL DEFAULT 1,
  active          INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE addons (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  price_idr      INTEGER NOT NULL,
  storage_bytes  INTEGER NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  sort           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE compress_packs (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  price_idr  INTEGER NOT NULL,
  credits    INTEGER NOT NULL,
  ttl_days   INTEGER NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0
);

-- Generic monotonic counters (invoice numbers, …).
CREATE TABLE counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL DEFAULT 0
);

-- Long-window usage limits that the Rate Limiting binding cannot express (ADR-004).
CREATE TABLE usage_counters (
  key           TEXT PRIMARY KEY,               -- e.g. share_email:{userId}:{yyyymmdd}
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX usage_counters_expires_idx ON usage_counters (expires_at);

-- ───────────────────────────── Storage pools & billing ─────────────────────────────
-- "Storage info" from the diagram. One pool per user (personal) or per family.
CREATE TABLE storage_pools (
  id              TEXT PRIMARY KEY,
  owner_type      TEXT NOT NULL,                -- user | family
  owner_id        TEXT NOT NULL,
  limit_bytes     INTEGER NOT NULL DEFAULT 0,
  used_bytes      INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  bonus_bytes     INTEGER NOT NULL DEFAULT 0 CHECK (bonus_bytes >= 0),   -- admin adjustment (audited)
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX storage_pools_owner_uq ON storage_pools (owner_type, owner_id);

CREATE TABLE subscriptions (
  id                    TEXT PRIMARY KEY,
  pool_id               TEXT NOT NULL REFERENCES storage_pools (id),
  payer_user_id         TEXT NOT NULL REFERENCES users (id),
  plan_code             TEXT NOT NULL REFERENCES plans (code),
  next_plan_code        TEXT REFERENCES plans (code),   -- scheduled downgrade
  status                TEXT NOT NULL,          -- active | grace | readonly | suspended | deleted | cancelled
  period_start          INTEGER NOT NULL,
  period_end            INTEGER NOT NULL,
  anchor_day            INTEGER NOT NULL,       -- day-of-month the subscription renews on (1..31)
  auto_renew            INTEGER NOT NULL DEFAULT 1,
  cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
  status_changed_at     INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX subscriptions_pool_idx ON subscriptions (pool_id, status);
CREATE INDEX subscriptions_period_end_idx ON subscriptions (period_end);

CREATE TABLE subscription_addons (
  id                    TEXT PRIMARY KEY,
  subscription_id       TEXT NOT NULL REFERENCES subscriptions (id),
  addon_code            TEXT NOT NULL REFERENCES addons (code),
  qty                   INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
  starts_at             INTEGER NOT NULL,
  ends_at               INTEGER
);
CREATE INDEX subscription_addons_sub_idx ON subscription_addons (subscription_id);

CREATE TABLE wallets (
  user_id      TEXT PRIMARY KEY REFERENCES users (id),
  balance_idr  INTEGER NOT NULL DEFAULT 0 CHECK (balance_idr >= 0),
  updated_at   INTEGER NOT NULL
);

-- Append-only.
CREATE TABLE wallet_ledger (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id),
  delta_idr      INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL CHECK (balance_after >= 0),
  reason         TEXT NOT NULL,
  ref            TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX wallet_ledger_user_idx ON wallet_ledger (user_id, created_at);
-- A paid payment credits the wallet exactly once (webhook replays are no-ops).
CREATE UNIQUE INDEX wallet_ledger_topup_uq ON wallet_ledger (ref) WHERE reason = 'topup';

CREATE TABLE payments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id),
  provider      TEXT NOT NULL,
  provider_ref  TEXT NOT NULL,
  method        TEXT NOT NULL,
  amount_idr    INTEGER NOT NULL CHECK (amount_idr > 0),
  fee_idr       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,                  -- pending | paid | failed | expired | refunded
  purpose       TEXT NOT NULL,                  -- topup | direct
  purpose_ref   TEXT,                           -- what a direct payment pays for
  raw_json      TEXT,
  created_at    INTEGER NOT NULL,
  paid_at       INTEGER,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments (provider, provider_ref);
CREATE INDEX payments_user_idx ON payments (user_id, created_at);

CREATE TABLE invoices (
  id            TEXT PRIMARY KEY,
  number        TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users (id),
  lines_json    TEXT NOT NULL,
  subtotal_idr  INTEGER NOT NULL,
  tax_idr       INTEGER NOT NULL DEFAULT 0,
  total_idr     INTEGER NOT NULL,
  status        TEXT NOT NULL,                  -- issued | paid | void
  payment_id    TEXT REFERENCES payments (id),
  issued_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX invoices_number_uq ON invoices (number);
CREATE INDEX invoices_user_idx ON invoices (user_id, issued_at);

-- Compress credits: plan quota (expires at period end), packs (ttl), refunds, usage (negative).
CREATE TABLE credit_ledger (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id),
  delta       INTEGER NOT NULL,
  remaining   INTEGER NOT NULL DEFAULT 0 CHECK (remaining >= 0),  -- for grants: credits left
  source      TEXT NOT NULL,                    -- plan | pack | refund | usage | adjust
  ref         TEXT,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX credit_ledger_user_idx ON credit_ledger (user_id, expires_at);

-- ───────────────────────────── Families ─────────────────────────────
CREATE TABLE families (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users (id),
  pool_id     TEXT NOT NULL REFERENCES storage_pools (id),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX families_owner_uq ON families (owner_id);

CREATE TABLE family_members (
  family_id       TEXT NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users (id),
  role            TEXT NOT NULL,                -- owner | member
  cap_bytes       INTEGER,
  used_bytes      INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  joined_at       INTEGER NOT NULL,
  PRIMARY KEY (family_id, user_id)
);
CREATE UNIQUE INDEX family_members_user_uq ON family_members (user_id);

CREATE TABLE family_invites (
  id           TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  invited_by   TEXT NOT NULL REFERENCES users (id),
  channel      TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  accepted_by  TEXT REFERENCES users (id),
  accepted_at  INTEGER,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX family_invites_token_uq ON family_invites (token_hash);

-- ───────────────────────────── Files ─────────────────────────────
-- Physical objects in R2 at u/{uploaderId}/{blobId}. Shared only inside one pool (refcount).
CREATE TABLE blobs (
  id            TEXT PRIMARY KEY,
  pool_id       TEXT NOT NULL REFERENCES storage_pools (id),
  r2_key        TEXT NOT NULL,
  size          INTEGER NOT NULL CHECK (size >= 0),
  sha256        TEXT,
  crc32         INTEGER,
  sniffed_mime  TEXT,
  uploader_id   TEXT NOT NULL REFERENCES users (id),
  refcount      INTEGER NOT NULL DEFAULT 1 CHECK (refcount >= 0),
  scan_status   TEXT NOT NULL DEFAULT 'pending', -- pending | clean | infected | skipped | error | quarantined
  scan_detail   TEXT,
  scan_attempts INTEGER NOT NULL DEFAULT 0,
  scanned_at    INTEGER,
  thumb_key     TEXT,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX blobs_r2_key_uq ON blobs (r2_key);
CREATE INDEX blobs_pool_idx ON blobs (pool_id);
CREATE INDEX blobs_orphan_idx ON blobs (refcount) WHERE refcount = 0;
CREATE INDEX blobs_sha256_idx ON blobs (sha256);

-- File tree. `rid` is a stable integer rowid used by FTS5; `id` (ULID) is the public key.
-- Every space has its own root folder (parent_id IS NULL only for roots), so the sibling-name
-- uniqueness index covers the top level too (SPEC §4).
CREATE TABLE nodes (
  rid                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL,
  pool_id             TEXT NOT NULL REFERENCES storage_pools (id),
  space               TEXT NOT NULL,            -- personal | family
  family_id           TEXT REFERENCES families (id),
  owner_id            TEXT NOT NULL REFERENCES users (id),
  created_by          TEXT NOT NULL REFERENCES users (id),
  parent_id           TEXT REFERENCES nodes (id),
  kind                TEXT NOT NULL,            -- file | folder (extensible, SPEC §17)
  name                TEXT NOT NULL,
  name_key            TEXT NOT NULL,            -- NFC + lowercase
  blob_id             TEXT REFERENCES blobs (id),
  size                INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
  mime                TEXT,
  family_can_edit     INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'ready', -- uploading | scanning | ready | rejected
  trashed_at          INTEGER,
  trashed_by          TEXT REFERENCES users (id),
  trash_root_id       TEXT,                     -- the node the user actually trashed
  purge_at            INTEGER,
  client_modified_at  INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX nodes_id_uq ON nodes (id);
CREATE UNIQUE INDEX nodes_sibling_name_uq ON nodes (parent_id, name_key) WHERE trashed_at IS NULL;
CREATE UNIQUE INDEX nodes_personal_root_uq ON nodes (owner_id)
  WHERE parent_id IS NULL AND space = 'personal';
CREATE UNIQUE INDEX nodes_family_root_uq ON nodes (family_id)
  WHERE parent_id IS NULL AND space = 'family';
CREATE INDEX nodes_parent_idx ON nodes (parent_id, trashed_at, kind, name_key);
CREATE INDEX nodes_pool_idx ON nodes (pool_id);
CREATE INDEX nodes_owner_idx ON nodes (owner_id, space);
CREATE INDEX nodes_blob_idx ON nodes (blob_id);
CREATE INDEX nodes_trash_idx ON nodes (trash_root_id) WHERE trash_root_id IS NOT NULL;
CREATE INDEX nodes_purge_idx ON nodes (purge_at) WHERE purge_at IS NOT NULL;
CREATE INDEX nodes_status_idx ON nodes (status, created_at) WHERE status != 'ready';

CREATE VIRTUAL TABLE nodes_fts USING fts5 (
  name,
  content = 'nodes',
  content_rowid = 'rid',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts (rowid, name) VALUES (new.rid, new.name);
END;
CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts (nodes_fts, rowid, name) VALUES ('delete', old.rid, old.name);
END;
CREATE TRIGGER nodes_fts_au AFTER UPDATE OF name ON nodes BEGIN
  INSERT INTO nodes_fts (nodes_fts, rowid, name) VALUES ('delete', old.rid, old.name);
  INSERT INTO nodes_fts (rowid, name) VALUES (new.rid, new.name);
END;

CREATE TABLE node_stars (
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, node_id)
);

-- Keep at most 200 rows per user (pruned by the service on write).
CREATE TABLE node_recent (
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  accessed_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, node_id)
);
CREATE INDEX node_recent_user_idx ON node_recent (user_id, accessed_at);

CREATE TABLE uploads (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id),
  pool_id         TEXT NOT NULL REFERENCES storage_pools (id),
  node_id         TEXT NOT NULL,
  blob_id         TEXT NOT NULL,
  r2_key          TEXT NOT NULL,
  r2_upload_id    TEXT,                         -- null for simple uploads
  size            INTEGER NOT NULL CHECK (size >= 0),
  part_size       INTEGER NOT NULL,
  total_parts     INTEGER NOT NULL,
  reserved_bytes  INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  member_user_id  TEXT,                         -- family member whose cap was reserved
  on_conflict     TEXT NOT NULL DEFAULT 'rename', -- rename | replace (name clash at complete)
  status          TEXT NOT NULL,                -- active | completed | aborted | expired
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX uploads_user_idx ON uploads (user_id, status);
CREATE INDEX uploads_expiry_idx ON uploads (status, expires_at);

CREATE TABLE upload_parts (
  upload_id    TEXT NOT NULL REFERENCES uploads (id) ON DELETE CASCADE,
  part_number  INTEGER NOT NULL,
  etag         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);

-- Users whose u/{userId}/index.json manifest must be rebuilt (debounced by cron).
CREATE TABLE manifest_dirty (
  user_id   TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  dirty_at  INTEGER NOT NULL
);

-- ───────────────────────────── Sharing ─────────────────────────────
CREATE TABLE shares (
  id                TEXT PRIMARY KEY,           -- r64
  created_by        TEXT NOT NULL REFERENCES users (id),
  kind              TEXT NOT NULL,              -- file | bundle | folder
  title             TEXT NOT NULL,
  expires_at        INTEGER,
  max_downloads     INTEGER,
  download_count    INTEGER NOT NULL DEFAULT 0,
  password_hash     TEXT,
  revoked_at        INTEGER,
  disabled_reason   TEXT,                       -- readonly | abuse | null
  last_download_at  INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX shares_creator_idx ON shares (created_by, created_at);

CREATE TABLE share_items (
  share_id  TEXT NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
  node_id   TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  PRIMARY KEY (share_id, node_id)
);
CREATE INDEX share_items_node_idx ON share_items (node_id);

CREATE TABLE share_sends (
  id                TEXT PRIMARY KEY,
  share_id          TEXT NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users (id),
  channel           TEXT NOT NULL,              -- qr | whatsapp | telegram | email | copy | webshare
  mode              TEXT NOT NULL,              -- deeplink | bot | api
  recipient_masked  TEXT,
  recipient_hash    TEXT,
  message           TEXT,
  status            TEXT NOT NULL,
  provider_ref      TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX share_sends_share_idx ON share_sends (share_id);
CREATE INDEX share_sends_user_idx ON share_sends (user_id, created_at);

CREATE TABLE contacts (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  display_name     TEXT NOT NULL,
  channel          TEXT NOT NULL,
  value_encrypted  TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX contacts_user_idx ON contacts (user_id);

CREATE TABLE telegram_links (
  user_id         TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  tg_user_id      TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  username_lower  TEXT,
  allow_receive   INTEGER NOT NULL DEFAULT 1,
  linked_at       INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX telegram_links_tg_uq ON telegram_links (tg_user_id);
CREATE INDEX telegram_links_username_idx ON telegram_links (username_lower);

-- Email recipients who unsubscribed from share emails.
CREATE TABLE email_suppressions (
  email_hash  TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- ───────────────────────────── Jobs ─────────────────────────────
CREATE TABLE archive_jobs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id),
  node_ids_json  TEXT NOT NULL,
  format         TEXT NOT NULL,                 -- zip_store | zip_deflate | tar_zst
  level          INTEGER,
  status         TEXT NOT NULL,                 -- queued | running | done | failed | expired
  progress       INTEGER NOT NULL DEFAULT 0,    -- 0..100
  total_bytes    INTEGER NOT NULL DEFAULT 0,
  out_key        TEXT,
  out_bytes      INTEGER,
  expires_at     INTEGER,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX archive_jobs_user_idx ON archive_jobs (user_id, status);

CREATE TABLE compress_jobs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id),
  batch_id        TEXT,
  source_node_id  TEXT,
  source_key      TEXT,                         -- standalone tmp/compress/… object
  kind            TEXT NOT NULL,                -- image | video
  engine          TEXT NOT NULL,                -- images | media | ffmpeg
  options_json    TEXT NOT NULL,
  status          TEXT NOT NULL,                -- queued | running | done | failed | skipped
  out_node_id     TEXT,
  out_key         TEXT,
  credits_used    INTEGER NOT NULL DEFAULT 0,
  saved_bytes     INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX compress_jobs_user_idx ON compress_jobs (user_id, created_at);
CREATE INDEX compress_jobs_batch_idx ON compress_jobs (batch_id);

-- ───────────────────────────── Ads ─────────────────────────────
CREATE TABLE ad_areas (
  code              TEXT PRIMARY KEY,           -- Kemendagri region code ('ID' = national)
  name              TEXT NOT NULL,
  level             TEXT NOT NULL,              -- national | province | regency
  parent_code       TEXT REFERENCES ad_areas (code),
  tier              TEXT NOT NULL,              -- tier1 | tier2 | tier3 | province | national
  cf_aliases_json   TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX ad_areas_parent_idx ON ad_areas (parent_code);

CREATE TABLE ad_prices (
  area_level         TEXT NOT NULL,
  tier               TEXT NOT NULL,
  placement          TEXT NOT NULL,             -- explorer_sidebar | share_page
  price_per_day_idr  INTEGER NOT NULL,
  active             INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (area_level, tier, placement)
);

CREATE TABLE ad_inventory (
  date          TEXT NOT NULL,                  -- YYYY-MM-DD (WIB)
  area_code     TEXT NOT NULL REFERENCES ad_areas (code),
  placement     TEXT NOT NULL,
  total_slots   INTEGER NOT NULL CHECK (total_slots >= 0),
  booked_slots  INTEGER NOT NULL DEFAULT 0 CHECK (booked_slots >= 0 AND booked_slots <= total_slots),
  PRIMARY KEY (date, area_code, placement)
);

CREATE TABLE advertisers (
  user_id           TEXT PRIMARY KEY REFERENCES users (id),
  business_name     TEXT NOT NULL,
  kind              TEXT NOT NULL,              -- umkm | mahasiswa | lainnya
  student_verified  INTEGER NOT NULL DEFAULT 0,
  student_email     TEXT,
  phone             TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE TABLE ad_creatives (
  id             TEXT PRIMARY KEY,
  advertiser_id  TEXT NOT NULL REFERENCES advertisers (user_id),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  image_key      TEXT,
  cta_type       TEXT NOT NULL,                 -- web | whatsapp | instagram | tiktok | shopee | tokopedia
  cta_value      TEXT NOT NULL,
  category       TEXT NOT NULL,
  status         TEXT NOT NULL,                 -- draft | pending | approved | rejected | suspended
  reject_reason  TEXT,
  reviewed_by    TEXT REFERENCES users (id),
  reviewed_at    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX ad_creatives_advertiser_idx ON ad_creatives (advertiser_id);
CREATE INDEX ad_creatives_status_idx ON ad_creatives (status, created_at);

CREATE TABLE ad_bookings (
  id               TEXT PRIMARY KEY,
  creative_id      TEXT NOT NULL REFERENCES ad_creatives (id),
  area_code        TEXT NOT NULL REFERENCES ad_areas (code),
  placement        TEXT NOT NULL,
  date             TEXT NOT NULL,               -- YYYY-MM-DD (WIB)
  price_idr        INTEGER NOT NULL,
  status           TEXT NOT NULL,               -- held | paid | live | completed | refunded | cancelled
  hold_expires_at  INTEGER,
  payment_id       TEXT REFERENCES payments (id),
  impressions      INTEGER NOT NULL DEFAULT 0,
  clicks           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX ad_bookings_serve_idx ON ad_bookings (date, area_code, placement, status);
CREATE INDEX ad_bookings_creative_idx ON ad_bookings (creative_id);
CREATE INDEX ad_bookings_hold_idx ON ad_bookings (status, hold_expires_at);

-- ───────────────────────────── Moderation & compliance ─────────────────────────────
CREATE TABLE abuse_reports (
  id                TEXT PRIMARY KEY,
  target_type       TEXT NOT NULL,              -- share | node | blob | ad | user
  target_id         TEXT NOT NULL,
  category          TEXT NOT NULL,
  priority          TEXT NOT NULL,              -- urgent | normal
  reporter_user_id  TEXT REFERENCES users (id),
  reporter_contact  TEXT,
  details           TEXT,
  status            TEXT NOT NULL,              -- open | in_review | resolved | rejected
  sla_due_at        INTEGER NOT NULL,
  resolved_by       TEXT REFERENCES users (id),
  resolved_at       INTEGER,
  action            TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX abuse_reports_queue_idx ON abuse_reports (status, priority, sla_due_at);
CREATE INDEX abuse_reports_target_idx ON abuse_reports (target_type, target_id);

CREATE TABLE blocked_hashes (
  sha256      TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE legal_holds (
  blob_id     TEXT PRIMARY KEY REFERENCES blobs (id),
  reason      TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users (id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  read_at       INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at);

CREATE TABLE notification_prefs (
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type     TEXT NOT NULL,
  channel  TEXT NOT NULL,                       -- inapp | email | telegram
  enabled  INTEGER NOT NULL,
  PRIMARY KEY (user_id, type, channel)
);

CREATE TABLE audit_logs (
  id           TEXT PRIMARY KEY,
  actor_id     TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  ip_hash      TEXT,
  meta_json    TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id, created_at);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at);
