-- ADR-054: a folder or several-file share link can open a page listing its files (each one
-- downloadable on its own, or all as one ZIP) instead of the ZIP right away.
ALTER TABLE shares ADD COLUMN show_listing INTEGER NOT NULL DEFAULT 0;
