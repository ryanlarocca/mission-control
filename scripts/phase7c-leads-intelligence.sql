-- Phase 7C — Leads Tab Intelligence schema migration. Idempotent.
--
-- Layers on top of 7B's drip schema:
--   * New flag columns (is_dnc, is_junk, is_bad_number) — separate from
--     status so a lead can be `warm` + `is_bad_number=true` and the drip
--     engine just skips phone/SMS touches while continuing email.
--   * AI summary cache (regenerated only when new activity arrives).
--   * Recommended follow-up (date + reason, set by AI from call transcripts,
--     surfaced in the new Follow-Up tab).
--   * suggested_status / suggested_status_reason — training wheels: AI
--     suggests a status from a transcript, Ryan confirms.
--   * campaign_label — display-side rename layer over the historical
--     `source` column (kept untouched for data integrity).
--   * dnc_list — standalone suppression list, structured to match the
--     direct-mail CSV format (parcel, owner, site/mail address) so it can
--     be exported and cross-referenced before sending a new mailer.
--   * campaign_metrics — coarse per-campaign counts, computed on demand.
--
-- Status remap collapses 7B's transitional values into the new lifecycle:
--   qualified → nurture, do_not_contact → dead+is_dnc, junk → is_junk,
--   unqualified → contacted (it was a soft mismatch, not dead).
--
-- Apply:
--   node scripts/run-migration.mjs scripts/phase7c-leads-intelligence.sql

ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_dnc BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_junk BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_bad_number BOOLEAN DEFAULT false;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_summary TEXT DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_summary_generated_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS recommended_followup_date DATE DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_reason TEXT DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_generated_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS suggested_status TEXT DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS suggested_status_reason TEXT DEFAULT NULL;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_label TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS dnc_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_number TEXT,
  owner_name TEXT,
  site_address TEXT,
  site_city TEXT,
  site_state TEXT DEFAULT 'CA',
  site_zip TEXT,
  mail_address TEXT,
  mail_city TEXT,
  mail_state TEXT,
  mail_zip TEXT,
  county TEXT,
  source_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  reason TEXT,
  added_at TIMESTAMPTZ DEFAULT now(),
  added_by TEXT DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_dnc_site_address ON dnc_list(site_address);
CREATE INDEX IF NOT EXISTS idx_dnc_parcel_number ON dnc_list(parcel_number);

CREATE TABLE IF NOT EXISTS campaign_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_source TEXT NOT NULL UNIQUE,
  total_leads INTEGER DEFAULT 0,
  total_calls INTEGER DEFAULT 0,
  total_texts INTEGER DEFAULT 0,
  total_emails INTEGER DEFAULT 0,
  total_voicemails INTEGER DEFAULT 0,
  hot_count INTEGER DEFAULT 0,
  warm_count INTEGER DEFAULT 0,
  nurture_count INTEGER DEFAULT 0,
  dead_count INTEGER DEFAULT 0,
  dnc_count INTEGER DEFAULT 0,
  junk_count INTEGER DEFAULT 0,
  last_computed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_recommended_followup_date ON leads(recommended_followup_date);
CREATE INDEX IF NOT EXISTS idx_leads_campaign_label ON leads(campaign_label);
CREATE INDEX IF NOT EXISTS idx_leads_is_dnc ON leads(is_dnc) WHERE is_dnc = true;
CREATE INDEX IF NOT EXISTS idx_leads_is_junk ON leads(is_junk) WHERE is_junk = true;

-- Status remap. Run after columns exist so the flag updates can ride along.
UPDATE leads SET status = 'nurture' WHERE status = 'qualified';
UPDATE leads SET status = 'dead', is_dnc = true WHERE status = 'do_not_contact';
UPDATE leads SET is_junk = true WHERE status = 'junk';
UPDATE leads SET status = 'contacted' WHERE status = 'unqualified';
-- Anything left ('junk' rows kept their status, but is_junk flag is now set;
-- moving them to 'dead' so the lifecycle column is clean and the flag drives
-- the filtering)
UPDATE leads SET status = 'dead' WHERE status = 'junk';
