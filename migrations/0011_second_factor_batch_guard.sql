-- ADR-056: when this session last proved a second factor (TOTP or passkey). Staff routes want it
-- fresh; NULL = never in this session.
ALTER TABLE sessions ADD COLUMN second_factor_at INTEGER;

-- ADR-056: a D1 batch has no interactive transaction, so a statement that must hold for the whole
-- batch inserts a 0 here when it does not; the CHECK fails and the batch rolls back. Never has rows.
CREATE TABLE batch_guards (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
