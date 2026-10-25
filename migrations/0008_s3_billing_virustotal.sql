-- Zeiko S3 is billed after the month from what was used (ADR-047), and new files of risky types are
-- checked with VirusTotal (ADR-046).

-- Unpaid bills move an account to read-only, then locked (the dunning cycle); `status` stays the
-- operator's switch.
ALTER TABLE s3_accounts ADD COLUMN billing_state TEXT NOT NULL DEFAULT 'ok';  -- ok | readonly | locked

-- What an account used in one calendar month (WIB): stored bytes sampled every hour, bytes served.
CREATE TABLE s3_usage (
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  period        TEXT NOT NULL,                       -- YYYY-MM
  gib_hours     REAL NOT NULL DEFAULT 0,
  egress_bytes  INTEGER NOT NULL DEFAULT 0,
  last_hour     INTEGER NOT NULL DEFAULT 0,          -- hours since the epoch of the last sample
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, period)
) WITHOUT ROWID;

CREATE TABLE s3_bills (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  period         TEXT NOT NULL,
  gib_months     REAL NOT NULL,
  egress_bytes   INTEGER NOT NULL,
  lines_json     TEXT NOT NULL,
  subtotal_idr   INTEGER NOT NULL,
  total_idr      INTEGER NOT NULL,                   -- tax included
  status         TEXT NOT NULL,                      -- open | paid | carried | waived
  due_at         INTEGER,
  carried_into   TEXT,                               -- the bill that took this small amount over
  invoice_id     TEXT,
  paid_at        INTEGER,
  waived_reason  TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE (user_id, period)
);
CREATE INDEX s3_bills_status_idx ON s3_bills (status, due_at);

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

-- Requests spent per minute and per day, so the Worker never asks more than the key allows.
CREATE TABLE vt_budget (
  slot        TEXT PRIMARY KEY,                      -- m:<minute> | d:<YYYY-MM-DD>
  used        INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) WITHOUT ROWID;
