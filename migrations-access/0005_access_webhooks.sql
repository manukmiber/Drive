-- A6 (ADR-094): webhooks. An endpoint a person registered (an https URL, the Drive events it wants,
-- its signing secret sealed with CONTACTS_ENC_KEY), and the deliveries of the last 7 days. Kept in
-- the access database with the API tokens they belong beside (ADR-064); no foreign keys.
CREATE TABLE webhooks (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  url             TEXT NOT NULL,
  secret_enc      TEXT NOT NULL,
  events_json     TEXT NOT NULL,             -- Drive events, e.g. ["drive.file.uploaded"]
  description     TEXT,
  failures        INTEGER NOT NULL DEFAULT 0, -- deliveries that gave up in a row
  disabled_at     INTEGER,
  disabled_reason TEXT,                       -- 'failing' or 'owner'
  last_success_at INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX webhooks_user_idx ON webhooks (user_id);

CREATE TABLE webhook_deliveries (
  id              TEXT PRIMARY KEY,
  webhook_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  event           TEXT NOT NULL,              -- the first event's name ("+n" more in `count`)
  count           INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL,              -- 'pending' | 'ok' | 'retrying' | 'failed'
  attempts        INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX webhook_deliveries_hook_idx ON webhook_deliveries (webhook_id, created_at);
CREATE INDEX webhook_deliveries_age_idx ON webhook_deliveries (created_at);
