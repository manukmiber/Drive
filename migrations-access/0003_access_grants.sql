-- D2 (ADR-085): a file or folder shared with a person's Zeiko account. Kept with the share links
-- (ADR-064 R0 no. 1: the access database holds who may open what), never in the main D1. `user_id`
-- is set once the person is known; an address that hasn't been to Drive yet waits in `email` and
-- is claimed the first time that account signs in. No foreign keys to `nodes` or `users`, which
-- live elsewhere: code removes grants when their node goes (services/grants.ts).
CREATE TABLE node_grants (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,
  owner_id    TEXT NOT NULL,                  -- the item's owner (whose pool it is)
  user_id     TEXT,
  email       TEXT,                           -- lowercase; only while user_id is null
  role        TEXT NOT NULL,                  -- view | edit
  granted_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER
);
CREATE UNIQUE INDEX node_grants_user_idx ON node_grants (node_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX node_grants_email_idx ON node_grants (node_id, email) WHERE user_id IS NULL;
CREATE INDEX node_grants_to_idx ON node_grants (user_id, created_at);
CREATE INDEX node_grants_waiting_idx ON node_grants (email) WHERE user_id IS NULL;
CREATE INDEX node_grants_owner_idx ON node_grants (owner_id);
