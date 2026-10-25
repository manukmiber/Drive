-- Zeiko S3 is paid upfront per month for a chosen size, with 1 or 3 copies (ADR-047), may answer on
-- an address of the person's own (ADR-048), and new files of risky types are checked with
-- VirusTotal (ADR-046).

-- A plan not renewed moves the account to read-only, then locked (the dunning cycle); `status`
-- stays the operator's switch.
ALTER TABLE s3_accounts ADD COLUMN billing_state TEXT NOT NULL DEFAULT 'ok';  -- ok | readonly | locked

-- What a person bought: `gb` GiB with `replicas` copies for [period_start, period_end). A smaller
-- plan waits in next_* until the next period. No row: storage granted by the operator.
CREATE TABLE s3_subscriptions (
  user_id        TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  gb             INTEGER NOT NULL,
  replicas       INTEGER NOT NULL,                   -- 1 | 3
  next_gb        INTEGER,
  next_replicas  INTEGER,
  anchor_day     INTEGER NOT NULL,
  period_start   INTEGER NOT NULL,
  period_end     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX s3_subscriptions_end_idx ON s3_subscriptions (period_end);

-- Bytes served per account and period (the plan's month, or the WIB month without a plan). Egress
-- past the free allowance in a paid period is added to a later renewal; `billed_blocks` is what was.
CREATE TABLE s3_usage (
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  period_start   INTEGER NOT NULL,
  billable       INTEGER NOT NULL DEFAULT 0,
  egress_bytes   INTEGER NOT NULL DEFAULT 0,
  billed_blocks  INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, period_start)
) WITHOUT ROWID;

-- An account's own S3 address: s3.<name>.<zeiko zone> (a Worker custom domain) or the person's own
-- domain (a Cloudflare for SaaS custom hostname + a Worker route). Paid once; released (row deleted)
-- when the plan has gone unpaid for s3_url_release_days.
CREATE TABLE s3_urls (
  hostname      TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                       -- zeiko | custom
  status        TEXT NOT NULL,                       -- reserved (being bought) | pending | active | failed
  cf_id         TEXT,                                -- custom domain / custom hostname id
  cf_route_id   TEXT,                                -- the Worker route (custom only)
  records_json  TEXT,                                -- DNS records the person must add (custom)
  error         TEXT,
  price_idr     INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- VirusTotal's answer per file hash, so the same file costs one request (500 a day on a free key).
CREATE TABLE vt_verdicts (
  sha256      TEXT PRIMARY KEY,
  verdict     TEXT NOT NULL,                         -- malicious | clean | unknown
  malicious   INTEGER NOT NULL DEFAULT 0,
  engines     INTEGER NOT NULL DEFAULT 0,
  label       TEXT,
  uploaded    INTEGER NOT NULL DEFAULT 0,            -- the file itself was sent for analysis
  checked_at  INTEGER NOT NULL
) WITHOUT ROWID;

-- Requests spent per minute, per day and per person, so the Worker never asks more than the key
-- allows.
CREATE TABLE vt_budget (
  slot        TEXT PRIMARY KEY,                      -- m:<minute> | d:<YYYY-MM-DD> | u:<user>:<day>
  used        INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) WITHOUT ROWID;
