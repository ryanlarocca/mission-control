-- Personal-cell channel for leads.
--
-- When true, this lead is texted from Ryan's personal cell via the iMessage
-- sidecar (same path the Relationships tab uses) instead of the Twilio
-- business line, and is excluded from the automated drip engine — it becomes
-- an "assisted-manual" lead: it still surfaces in Follow-Ups with an AI draft,
-- but nothing auto-sends.
--
-- NOT NULL DEFAULT false is load-bearing: the drip engine's eligible-lead
-- query gates with `.eq("use_personal_cell", false)`, and in PostgREST a NULL
-- value is NOT equal to false (it would be filtered OUT). A plain `ADD COLUMN
-- ... DEFAULT false` backfills every existing row with false, so legacy leads
-- stay in drip scope. Keeping the column NOT NULL guarantees it stays that way.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS use_personal_cell BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN leads.use_personal_cell IS
  'When true, this lead is texted from Ryan''s personal cell via the iMessage sidecar instead of the Twilio business line, and is excluded from the automated drip engine (assisted-manual). Toggled per-lead from the lead card.';
