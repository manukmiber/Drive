-- ADR-062: Idempotency-Key on /api/v1 POSTs that make something. One row per token and key for 24
-- hours: the request's hash and, once done, the first answer (status 0 = still running).
CREATE TABLE api_idempotency (
  token_id     TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status       INTEGER NOT NULL,
  body         TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (token_id, key)
) WITHOUT ROWID;
CREATE INDEX api_idempotency_age_idx ON api_idempotency (created_at);
