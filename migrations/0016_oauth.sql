-- ADR-063: sign-in for Zeiko's own apps (OAuth 2.0 authorization code + PKCE). The clients are fixed
-- in code (services/oauth.ts). A grant is one app connected to one account; its access and refresh
-- tokens are api_tokens rows (kind oauth_access / oauth_refresh) carrying the grant's id.
CREATE TABLE oauth_grants (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id),
  client_id    TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX oauth_grants_user_idx ON oauth_grants (user_id, created_at);

-- A code lives a minute and is used once; only its hash is kept. `grant_id` is set when it was
-- exchanged, so a second use can revoke what the first one made.
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users (id),
  redirect_uri   TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER,
  grant_id       TEXT
);
CREATE INDEX oauth_codes_expiry_idx ON oauth_codes (expires_at);

ALTER TABLE api_tokens ADD COLUMN grant_id TEXT;
CREATE INDEX api_tokens_grant_idx ON api_tokens (grant_id) WHERE grant_id IS NOT NULL;
