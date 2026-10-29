-- R6 (ADR-080): API tokens, OAuth connections and codes, and Idempotency-Key answers move to the
-- access database. Same columns as in the main D1 (0014–0016); no foreign keys to `users`, which
-- stays in the main D1 until R7. Sessions stay with Better Auth's users there too (ADR-080).
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL UNIQUE,
  secret_hash  TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'personal',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  grant_id     TEXT
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id, created_at);
CREATE INDEX api_tokens_grant_idx ON api_tokens (grant_id) WHERE grant_id IS NOT NULL;

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

CREATE TABLE oauth_grants (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX oauth_grants_user_idx ON oauth_grants (user_id, created_at);

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER,
  grant_id       TEXT
);
CREATE INDEX oauth_codes_expiry_idx ON oauth_codes (expires_at);
