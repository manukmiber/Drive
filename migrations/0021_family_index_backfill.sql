-- R4 (ADR-078): every family gets its own index (`f/{familyId}/index.txt`). A member's flush writes
-- it, so marking each family's owner is enough; the next request or the hourly cron writes them.
-- Data only: no table or column changes.
INSERT INTO manifest_dirty (user_id, dirty_at)
SELECT f.owner_id, 1
FROM families f JOIN users u ON u.id = f.owner_id
WHERE u.status != 'deleted'
ON CONFLICT (user_id) DO UPDATE SET dirty_at = excluded.dirty_at;
