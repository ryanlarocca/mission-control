-- Website leads are call-first (Ryan, 2026-11-02): a form submission starts a
-- three-attempt call ladder (now → ~2h later → next morning), not a drip.
-- Only when all three calls go unanswered does the short website_followup
-- drip start. See briefs/BRIEF_WEBSITE_CALL_FIRST_2026-11-02.md.
--
--   sms_consent        — the form's "texts OK" box, on the website form row.
--                        Gates the first text and the "just tried you" texts
--                        (no consent → those go by email instead).
--   website_ladder     — 'calling' while the ladder runs, 'done' once a call
--                        connected, the lead reached back, or the ladder ran
--                        out (→ drip). Null on every other row.
--   ladder_pings       — which Telegram reminders already went out, keyed by
--                        attempt ("1r" = the 15-minute reminder for attempt 1,
--                        "2"/"3" = attempt-due pings). The 5-minute sweep
--                        reads it so each ping fires once.
--   call_conversation  — on an outbound call row: true = a real conversation
--                        with the lead, false = no answer / voicemail. Set by
--                        the call status callback and the recording pipeline.
--
-- Applied from the Mac mini: node scripts/run-migration.mjs supabase/migrations/2026-11-02_website_call_first.sql
alter table public.leads add column if not exists sms_consent boolean;
alter table public.leads add column if not exists website_ladder text;
alter table public.leads add column if not exists ladder_pings jsonb not null default '{}'::jsonb;
alter table public.leads add column if not exists call_conversation boolean;
create index if not exists leads_website_ladder_idx on public.leads (website_ladder) where website_ladder is not null;
