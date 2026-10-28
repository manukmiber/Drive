-- ADR-072: a bucket's lifecycle rules (PutBucketLifecycleConfiguration), and how far the hourly run has got.
-- `lifecycle_json` = the cleaned rules; NULL = none. `lifecycle_cursor` = {"rule": n, "after": "<key>"} while a
-- pass is under way; `lifecycle_at` = when the last whole pass finished.
ALTER TABLE s3_buckets ADD COLUMN lifecycle_json TEXT;
ALTER TABLE s3_buckets ADD COLUMN lifecycle_cursor TEXT;
ALTER TABLE s3_buckets ADD COLUMN lifecycle_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX s3_buckets_lifecycle_idx ON s3_buckets (lifecycle_at) WHERE lifecycle_json IS NOT NULL;
