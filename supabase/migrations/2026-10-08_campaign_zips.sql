-- Zip-cut picker for direct-mail list builds (NOO Q4 2026, 2026-10-08).
-- One row per SITE zip in a campaign's candidate list. Ryan ticks `exclude`
-- from his phone (/campaigns/zips?campaign=<id>); the list-build script reads
-- exclude = true back as the Step 6 zip cut. Idempotent.

CREATE TABLE IF NOT EXISTS campaign_zips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  zip text NOT NULL,
  city text,
  county text,
  rows integer NOT NULL DEFAULT 0,
  median_year_built integer,
  median_tenure_years numeric,
  cumulative_in_county integer,
  exclude boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, zip, county)
);
CREATE INDEX IF NOT EXISTS idx_campaign_zips_campaign ON campaign_zips(campaign_id);

-- A zip can straddle a county line (94303 is East Palo Alto in San Mateo and
-- Palo Alto in Santa Clara) — the natural key is (campaign, zip, county).
ALTER TABLE campaign_zips DROP CONSTRAINT IF EXISTS campaign_zips_campaign_id_zip_key;
CREATE UNIQUE INDEX IF NOT EXISTS campaign_zips_campaign_zip_county_uniq ON campaign_zips(campaign_id, zip, county);
