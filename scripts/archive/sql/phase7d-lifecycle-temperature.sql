-- Phase 7D — split lifecycle (Ryan-controlled) from temperature
-- (AI-controlled). Idempotent.
--
-- Before 7D, `status` was a 7-value union mixing lifecycle stage with
-- temperature: new / contacted / active / hot / warm / nurture / dead.
-- Phase 7D narrows `status` to four lifecycle values and adds a new
-- `temperature` column that the AI auto-fills from call transcripts.
--
-- New lifecycle (Ryan clicks):  new / contacted / active / dead
-- New temperature (AI sets):    hot / warm / cold
--
-- Mapping for legacy rows:
--   hot     → status='active',    temperature='hot'
--   warm    → status='active',    temperature='warm'
--   nurture → status='contacted', temperature='cold'
--   new / contacted / active / dead → unchanged, temperature stays NULL
--   (legacy 7B values qualified/junk/unqualified/do_not_contact were
--   already remapped by phase7c-leads-intelligence.sql; no work here.)
--
-- Apply:
--   node scripts/run-migration.mjs scripts/phase7d-lifecycle-temperature.sql

ALTER TABLE leads ADD COLUMN IF NOT EXISTS temperature TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_temperature ON leads(temperature);

UPDATE leads SET temperature = 'hot',  status = 'active'    WHERE status = 'hot';
UPDATE leads SET temperature = 'warm', status = 'active'    WHERE status = 'warm';
UPDATE leads SET temperature = 'cold', status = 'contacted' WHERE status = 'nurture';
