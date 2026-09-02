-- Phase 8 schema migration — adds the `suggested_reply` column used by the
-- email-lead AI triage. Haiku writes a draft reply Ryan can edit + send from
-- the lead card. Idempotent: safe to re-run.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS suggested_reply TEXT;
