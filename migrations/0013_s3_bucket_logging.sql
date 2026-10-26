-- ADR-060: a bucket's server access logging (PutBucketLogging) and when its logs were last delivered.
-- `logging_json` = {"target": "<bucket>", "prefix": "<key prefix>"}; NULL = off.
ALTER TABLE s3_buckets ADD COLUMN logging_json TEXT;
ALTER TABLE s3_buckets ADD COLUMN logs_at INTEGER;
CREATE INDEX s3_buckets_logging_idx ON s3_buckets (logs_at) WHERE logging_json IS NOT NULL;
