-- R3 (ADR-074): every Drive change is now written to the user's index in R2 (u/{userId}/index.txt).
-- Data only, no schema change: mark every user who has a personal tree, and the hourly cron
-- (drive_index_flush) writes their first index a few users per run.
INSERT INTO manifest_dirty (user_id, dirty_at)
SELECT DISTINCT n.owner_id, 1
FROM nodes n JOIN users u ON u.id = n.owner_id
WHERE n.space = 'personal' AND u.status != 'deleted'
ON CONFLICT (user_id) DO UPDATE SET dirty_at = excluded.dirty_at;
