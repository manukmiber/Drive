-- ADR-092 (S5): bucket versioning and Object Lock for Zeiko S3.
-- `versioning`: NULL = never turned on, 'Enabled', 'Suspended' (Amazon's three states; once on, a bucket never goes
-- back to NULL). `object_lock_json`: NULL = no Object Lock; {"mode": "GOVERNANCE"|"COMPLIANCE"|null, "days": n?,
-- "years": n?} once the bucket has it (the default retention for new objects, if any).
ALTER TABLE s3_buckets ADD COLUMN versioning TEXT;
ALTER TABLE s3_buckets ADD COLUMN object_lock_json TEXT;
