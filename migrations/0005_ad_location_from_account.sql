-- ADR-041: the city (required at sign-up) and postal code (optional) come from the Zeiko Account and
-- are copied here at every sign-in. ad_city_code stays the matched ad_areas code (NULL: no match).
ALTER TABLE users ADD COLUMN ad_city TEXT;
ALTER TABLE users ADD COLUMN ad_postal_code TEXT;
