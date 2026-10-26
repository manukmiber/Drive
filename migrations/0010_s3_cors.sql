-- ADR-055: a Zeiko S3 bucket's CORS rules (PutBucketCors), as JSON; NULL = no CORS configuration.
ALTER TABLE s3_buckets ADD COLUMN cors_json TEXT;
