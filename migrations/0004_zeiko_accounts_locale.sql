-- ADR-036: people sign in with Zeiko Accounts (accounts.provider_id = 'zeiko', already unique per
-- account_id), and every screen and email speaks Indonesian or English.
ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'id' CHECK (locale IN ('id', 'en'));
