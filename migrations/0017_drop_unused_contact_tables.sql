-- ADR-064 (owner, 2026-10-26, R0 no. 3): two tables nothing uses are dropped.
-- telegram_links: what was left of the Telegram bot ADR-041 took out (only read for the account
-- export and cleared at deletion); the share dialog's Telegram button is a plain t.me link.
-- contacts: never read or written by any code.
DROP TABLE IF EXISTS telegram_links;
DROP TABLE IF EXISTS contacts;
