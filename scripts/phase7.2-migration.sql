-- Phase 7.2 schema migration — adds lead-record fields used by the historical
-- import, AI auto-triage, and the Google Ads bridge. Idempotent: safe to
-- re-run. Run in the Supabase SQL Editor once.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_address text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_notes text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_type text;

UPDATE leads SET source_type = 'direct_mail'
WHERE source IN ('MFM-A', 'MFM-B') AND source_type IS NULL;

UPDATE leads SET source_type = 'google_ads'
WHERE source = 'Google Ads' AND source_type IS NULL;
