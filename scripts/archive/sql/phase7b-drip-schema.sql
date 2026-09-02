-- Phase 7B — Lead Drip System schema migration. Idempotent: safe to re-run.
--
-- Adds drip-tracking columns to `leads` and creates `drip_queue` for the
-- approval gate (drip engine queues a row, Ryan approves via Mission Control
-- UI or the engine's next pass picks up auto-approvals).
--
-- New `leads.status` values added by this phase ('active', 'unqualified',
-- 'do_not_contact') need no DDL — the column is plain TEXT, validation lives
-- in app/api/leads/route.ts (VALID_STATUSES) and the LeadStatus union in
-- lib/leads.ts.
--
-- Apply:
--   node scripts/run-migration.mjs scripts/phase7b-drip-schema.sql

ALTER TABLE leads ADD COLUMN IF NOT EXISTS drip_touch_number INTEGER DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS drip_campaign_type TEXT DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_drip_sent_at TIMESTAMPTZ DEFAULT NULL;

-- drip_queue holds generated touches awaiting approval. Auto-send mode
-- (DRIP_AUTO_SEND=true) skips this table entirely. status flow:
--   pending  → engine generated and queued, Telegram alert fired
--   approved → Ryan tapped Approve in Mission Control (or auto-send=true)
--   sent     → engine drained the queue and dispatched via sidecar/Gmail
--   skipped  → Ryan tapped Skip; touch counter still advances on the lead
CREATE TABLE IF NOT EXISTS drip_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  touch_number INTEGER NOT NULL,
  campaign_type TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('imessage', 'email')),
  message TEXT NOT NULL,
  subject TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'skipped', 'sent', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ DEFAULT NULL,
  sent_at TIMESTAMPTZ DEFAULT NULL,
  error TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_drip_queue_status ON drip_queue(status);
CREATE INDEX IF NOT EXISTS idx_drip_queue_lead_id ON drip_queue(lead_id);
CREATE INDEX IF NOT EXISTS idx_leads_drip_campaign_type ON leads(drip_campaign_type);
