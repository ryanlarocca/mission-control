-- Press 1 to accept (Ryan, 2026-10-27). On the NOO Q4 lines Ryan's cell
-- leg runs a short screen ("LRG lead call, press 1"). A declined or busy
-- call is picked up by his carrier voicemail, which Twilio reports as
-- "answered"; voicemail can't press 1, so only a real pickup stamps this.
-- /api/leads/voice/no-answer treats a screened call without the stamp as
-- missed (coin flip / voicemail).
--
-- Applied from the Mac mini: node scripts/run-migration.mjs supabase/migrations/2026-10-27_ryan_picked_up_at.sql
alter table public.leads add column if not exists ryan_picked_up_at timestamptz;
