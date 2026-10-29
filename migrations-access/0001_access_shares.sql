-- The access database `zeiko-access` (binding ACCESS_DB, ADR-064 R0 no. 1, ADR-079): sessions,
-- tokens, OAuth and share links, apart from the file tree and from Zeiko S3. R5 moves the share
-- links here. Same columns as in the main D1 (0001 + 0009); no foreign keys to `nodes` or `users`,
-- which live elsewhere: code removes a share item when its node goes (services/shares.ts).
CREATE TABLE shares (
  id                TEXT PRIMARY KEY,           -- r64
  created_by        TEXT NOT NULL,
  kind              TEXT NOT NULL,              -- file | bundle | folder
  title             TEXT NOT NULL,
  expires_at        INTEGER,
  max_downloads     INTEGER,
  download_count    INTEGER NOT NULL DEFAULT 0,
  password_hash     TEXT,
  revoked_at        INTEGER,
  disabled_reason   TEXT,                       -- readonly | abuse | null
  last_download_at  INTEGER,
  created_at        INTEGER NOT NULL,
  show_listing      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX shares_creator_idx ON shares (created_by, created_at);

CREATE TABLE share_items (
  share_id  TEXT NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
  node_id   TEXT NOT NULL,
  PRIMARY KEY (share_id, node_id)
);
CREATE INDEX share_items_node_idx ON share_items (node_id);

CREATE TABLE share_sends (
  id                TEXT PRIMARY KEY,
  share_id          TEXT NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
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
