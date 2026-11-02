-- A6 (ADR-094): a bucket's event notifications (PutBucketNotificationConfiguration), as JSON rules:
-- [{"id", "webhookId", "events": ["s3:ObjectCreated:*", …], "prefix"?, "suffix"?}]. NULL = none.
ALTER TABLE s3_buckets ADD COLUMN notification_json TEXT;
