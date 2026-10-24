-- ADR-043: an ad is a campaign the operator enters after the advertiser emails in, checks by hand,
-- and the advertiser pays from the QRIS in the approval email. No slots: every live campaign for a
-- viewer's city and every national one rotate in the card, one every 15 seconds. ad_inventory,
-- ad_bookings and ad_prices stay in the schema and are no longer read.
CREATE TABLE ad_campaigns (
  id                 TEXT PRIMARY KEY,
  advertiser_id      TEXT NOT NULL REFERENCES advertisers (user_id),
  creative_id        TEXT NOT NULL REFERENCES ad_creatives (id),
  scope              TEXT NOT NULL,              -- cities | national
  start_date         TEXT NOT NULL,              -- YYYY-MM-DD (WIB), first day shown
  end_date           TEXT NOT NULL,              -- YYYY-MM-DD (WIB), last day shown
  days               INTEGER NOT NULL CHECK (days >= 1),
  price_per_day_idr  INTEGER NOT NULL CHECK (price_per_day_idr >= 0),
  total_idr          INTEGER NOT NULL CHECK (total_idr >= 0),
  -- pending (its creative is not checked yet) | awaiting_payment | paid | live | completed
  -- | rejected | expired (not paid by its first day) | cancelled | suspended
  status             TEXT NOT NULL,
  reason             TEXT,
  -- The QRIS opened for it when it was approved, sent in the email (the advertiser pays from there).
  payment_id         TEXT REFERENCES payments (id),
  pay_amount_idr     INTEGER,
  pay_qris           TEXT,
  pay_url            TEXT,
  created_by         TEXT NOT NULL,
  paid_at            INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX ad_campaigns_status_idx ON ad_campaigns (status, start_date);
CREATE INDEX ad_campaigns_advertiser_idx ON ad_campaigns (advertiser_id, created_at);
CREATE INDEX ad_campaigns_creative_idx ON ad_campaigns (creative_id);

-- Where a campaign shows: area codes of cities/regencies, or the single row 'ID' for national.
CREATE TABLE ad_campaign_areas (
  campaign_id  TEXT NOT NULL REFERENCES ad_campaigns (id),
  area_code    TEXT NOT NULL REFERENCES ad_areas (code),
  PRIMARY KEY (campaign_id, area_code)
);
CREATE INDEX ad_campaign_areas_area_idx ON ad_campaign_areas (area_code, campaign_id);

-- Per day and per viewer area (the area the ad was served for): no user IDs, as before.
CREATE TABLE ad_campaign_stats (
  campaign_id  TEXT NOT NULL REFERENCES ad_campaigns (id),
  date         TEXT NOT NULL,
  area_code    TEXT NOT NULL,
  impressions  INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, date, area_code)
);
