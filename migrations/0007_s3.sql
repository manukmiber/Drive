-- Zeiko S3 (ADR-044): S3-compatible object storage served by this Worker, objects in the same R2
-- bucket under s3/{userId}/. This database holds who may use it (accounts, access keys, buckets).
-- Each account's object index lives in its own D1 once one is bound (index_binding), or in this
-- database until then; those index tables are created by src/worker/services/s3-index.ts.

CREATE TABLE s3_accounts (
  user_id         TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'active',    -- active | suspended | deleting
  limit_bytes     INTEGER NOT NULL DEFAULT 0,
  used_bytes      INTEGER NOT NULL DEFAULT 0,
  reserved_bytes  INTEGER NOT NULL DEFAULT 0,
  index_binding   TEXT,                              -- D1 binding name; NULL = this database
  swept_at        INTEGER NOT NULL DEFAULT 0,        -- last stale-multipart sweep (cron)
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX s3_accounts_binding_uq ON s3_accounts (index_binding)
  WHERE index_binding IS NOT NULL;

CREATE TABLE s3_keys (
  id            TEXT PRIMARY KEY,                    -- the access key id
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT '',
  secret_enc    TEXT NOT NULL,                       -- AES-GCM under S3_KEYS_ENC_KEY
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX s3_keys_user_idx ON s3_keys (user_id, created_at);

-- Bucket names are global (path-style URLs and public buckets need one owner per name).
CREATE TABLE s3_buckets (
  name        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  public      INTEGER NOT NULL DEFAULT 0,
  blocked_at  INTEGER,                               -- public access switched off by Zeiko
  created_at  INTEGER NOT NULL
);
CREATE INDEX s3_buckets_user_idx ON s3_buckets (user_id, name);
