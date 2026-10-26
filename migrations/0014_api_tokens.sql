-- ADR-061: access tokens for the public API (/api/v1), WebDAV and apps. The secret is shown once;
-- only its SHA-256 is kept. `prefix` is the token's public id (zkd_ + 8 characters), unique, so a
-- token is found by it and its secret compared in constant time. `kind`: personal (made in Settings)
-- or oauth (an app's access/refresh token, A3).
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id),
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL UNIQUE,
  secret_hash  TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'personal',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id, created_at);
