-- Text bounces show on the card (Ryan 2026-11-16): when an autopilot text
-- doesn't deliver (landline / unreachable), scripts/autopilot.js takes the
-- person off autopilot and flags the number. Two columns so the cards can
-- say so:
--   bad_number_reason  on the flagged row: why the number can't take texts —
--                      'landline' | 'unreachable'. Set only by the autopilot
--                      bounce; null for a hand-set Bad Number flag. Cleared
--                      when the flag is cleared (PATCH /api/leads).
--   send_error         on an outbound text row: it didn't deliver, and why
--                      (same values). Shown on that text in the history.
--
-- Applied from the Mac mini: node scripts/run-migration.mjs supabase/migrations/2026-11-16_text_bounce.sql
alter table public.leads add column if not exists bad_number_reason text;
alter table public.leads add column if not exists send_error text;

-- lead_history_v (2026-10-26_leads_history_line.sql) + send_error, appended
-- last so create-or-replace keeps the existing columns in place.
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
  recording_url is not null as has_recording,
  send_error
from public.leads;

revoke all on public.lead_history_v from anon, authenticated;
