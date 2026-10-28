-- Restricted Zeiko S3 access keys (ADR-071). Every column NULL / 'rw' = no limit, so each key made before this
-- keeps full access.
ALTER TABLE s3_keys ADD COLUMN buckets_json TEXT;               -- JSON array of bucket names; NULL = every bucket
ALTER TABLE s3_keys ADD COLUMN prefix TEXT;                     -- only object keys starting with this; NULL = all
ALTER TABLE s3_keys ADD COLUMN access TEXT NOT NULL DEFAULT 'rw'; -- rw | r (read only) | w (write only)
ALTER TABLE s3_keys ADD COLUMN expires_at INTEGER;              -- ms UTC; NULL = never
