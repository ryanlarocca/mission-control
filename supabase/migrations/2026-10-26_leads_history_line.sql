-- "Recent history" on Follow Ups cards (Ryan 2026-10-26): the skip-trace dump
-- is replaced by the last few calls / voicemails / texts, one line each.
--
-- `history_line` = a one-line AI summary of a long call or voicemail
-- transcript, written once the first time a card shows it
-- (/api/follow-ups/history-lines) and reused after that. Null = not
-- summarised yet (or a short message that is shown as-is).
--
-- `lead_history_v` = the event columns the worklist needs, with the long
-- text fields cut to their first 400 chars. The Follow Ups list refetches
-- every 30 s; this keeps full transcripts out of that payload. The full text
-- is fetched per contact on tap (/api/follow-ups/history).
--
-- Applied from the Mac mini: node scripts/run-migration.mjs supabase/migrations/2026-10-26_leads_history_line.sql
alter table public.leads add column if not exists history_line text;

create or replace view public.lead_history_v
with (security_invoker = true) as
select
  id,
  created_at,
  lead_type,
  twilio_number,
  caller_phone,
  email,
  gmail_thread_id,
  left(message, 400) as message_head,
  coalesce(length(message), 0) as message_len,
  left(ai_notes, 400) as ai_notes_head,
  history_line,
  recording_url is not null as has_recording
from public.leads;

-- Server-only (service role). security_invoker already applies the leads
-- RLS to any other role; the revoke keeps it off the anon API surface too.
revoke all on public.lead_history_v from anon, authenticated;
