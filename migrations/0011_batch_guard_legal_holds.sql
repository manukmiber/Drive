-- ADR-056: a D1 batch has no interactive transaction, so a statement that must hold for the whole
-- batch inserts a 0 here when it does not; the CHECK fails and the batch rolls back. Never has rows.
CREATE TABLE batch_guards (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- ADR-057: holds are placed by the relay's operator or automatically, and neither is a Drive user,
-- so `created_by` no longer references users. Nothing references legal_holds.
CREATE TABLE legal_holds_next (
  blob_id     TEXT PRIMARY KEY REFERENCES blobs (id),
  reason      TEXT NOT NULL,
  created_by  TEXT NOT NULL,              -- relay-operator | auto
  created_at  INTEGER NOT NULL
);
INSERT INTO legal_holds_next (blob_id, reason, created_by, created_at)
  SELECT blob_id, reason, created_by, created_at FROM legal_holds;
DROP TABLE legal_holds;
ALTER TABLE legal_holds_next RENAME TO legal_holds;
