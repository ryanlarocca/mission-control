-- Sales Coach (Ryan, 2026-11-02): scripts on the call card, ratings on
-- Telegram, both kept as JSON so the weekly pattern view can read them.
--
--   leads.coach_script           — the Opus script shown on the card for an
--                                  outbound call row (hook, voicemail lines,
--                                  live opener/questions/objection). The
--                                  rater reads it to say whether it was used.
--   leads.coach_rating           — the post-call rating for that call row
--                                  (score, went_well, improve, advice, ...).
--   relationship_touches.coach_rating — same, for Relationships-tab calls.
--
-- Applied from the Mac mini: node scripts/run-migration.mjs supabase/migrations/2026-11-02_coach.sql
alter table public.leads add column if not exists coach_script jsonb;
alter table public.leads add column if not exists coach_rating jsonb;
alter table public.relationship_touches add column if not exists coach_rating jsonb;
