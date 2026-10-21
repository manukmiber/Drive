-- Catalog seed from the pricing spreadsheet (SPEC Lampiran A) and cost assumptions (Lampiran B).
-- Values are editable from the admin panel; this only provides the initial rows.
-- GB = 2^30 bytes (SPEC §0.2).

INSERT INTO plans (code, name, kind, price_idr, storage_bytes, compress_quota, max_members, max_file_bytes, show_ads, active, sort) VALUES
  ('mini', 'Mini', 'personal', 1000, 3221225472, 50, 1, 3221225472, 1, 1, 1),
  ('basic', 'Basic', 'personal', 5000, 21474836480, 200, 1, 21474836480, 1, 1, 2),
  ('plus', 'Plus', 'personal', 25000, 128849018880, 800, 1, 128849018880, 1, 1, 3),
  ('pro', 'Pro', 'personal', 50000, 268435456000, 1500, 1, 268435456000, 1, 1, 4),
  ('max', 'Max', 'personal', 100000, 644245094400, 3000, 1, 644245094400, 1, 1, 5),
  -- Family plan: price/quota not in the spreadsheet yet (SPEC §16 #3) → inactive placeholder.
  ('family', 'Keluarga', 'family', 0, 268435456000, 1500, 6, 268435456000, 1, 0, 10);

INSERT INTO addons (code, name, price_idr, storage_bytes, active, sort) VALUES
  ('addon_10', 'Tambah 10GB', 5000, 10737418240, 1, 1),
  ('addon_50', 'Tambah 50GB', 20000, 53687091200, 1, 2),
  ('addon_100', 'Tambah 100GB', 35000, 107374182400, 1, 3);

INSERT INTO compress_packs (code, name, price_idr, credits, ttl_days, active, sort) VALUES
  ('kompres_100', 'Kompres 100', 2000, 100, 90, 1, 1),
  ('kompres_500', 'Kompres 500', 7000, 500, 90, 1, 2),
  ('kompres_1500', 'Kompres 1.500', 18000, 1500, 90, 1, 3),
  ('kompres_5000', 'Kompres 5.000', 55000, 5000, 90, 1, 4);

-- Lampiran B (other keys fall back to src/shared/config-defaults.ts until edited).
INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES
  ('usd_idr_rate', '18000', 'seed', 0),
  ('r2_storage_usd_per_gb_month', '0.015', 'seed', 0),
  ('image_transform_usd_per_1000', '0.5', 'seed', 0),
  ('video_transform_usd_per_1000', '0.5', 'seed', 0),
  ('free_transforms_per_month', '5000', 'seed', 0),
  ('usage_scenarios_pct', '[20,50,100]', 'seed', 0);

-- Ad prices placeholder (SPEC §10.6), Rp per slot per day. share_page = 50%.
INSERT INTO ad_prices (area_level, tier, placement, price_per_day_idr, active) VALUES
  ('regency', 'tier1', 'explorer_sidebar', 10000, 1),
  ('regency', 'tier1', 'share_page', 5000, 1),
  ('regency', 'tier2', 'explorer_sidebar', 5000, 1),
  ('regency', 'tier2', 'share_page', 2500, 1),
  ('regency', 'tier3', 'explorer_sidebar', 3000, 1),
  ('regency', 'tier3', 'share_page', 1500, 1),
  ('province', 'province', 'explorer_sidebar', 15000, 1),
  ('province', 'province', 'share_page', 7500, 1),
  ('national', 'national', 'explorer_sidebar', 50000, 1),
  ('national', 'national', 'share_page', 25000, 1);

INSERT INTO ad_areas (code, name, level, parent_code, tier, cf_aliases_json) VALUES ('ID', 'Indonesia', 'national', NULL, 'national', '["Indonesia"]');
