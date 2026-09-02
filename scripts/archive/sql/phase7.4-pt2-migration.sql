-- Phase 7.4 part 2 — adds the `gmail_thread_id` column used by the email-lead
-- pipeline to look up the full Gmail thread on Leads-tab card expand.
-- Idempotent: safe to re-run.
--
-- Apply once via Supabase SQL editor:
--   https://supabase.com/dashboard/project/<project>/sql
-- (Paste, click Run. Takes ~50ms.)

ALTER TABLE leads ADD COLUMN IF NOT EXISTS gmail_thread_id TEXT;
