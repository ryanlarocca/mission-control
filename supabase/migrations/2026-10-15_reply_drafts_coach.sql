-- Coached drafts (briefs/BRIEF_COACHED_DRAFT_2026-10-15.md §D).
-- Two draft modes share reply_drafts: "auto" (Haiku plan → Sonnet draft, as
-- before) and "coach" (Ryan dictates the gist, Opus reads the whole history
-- and returns a read + the draft). Coached sends become the top exemplars and
-- their gists feed the playbook's pending list, so the gist and the read are
-- stored on the row.
--
-- Applied from the Mac mini: node scripts/run-migration.mjs supabase/migrations/2026-10-15_reply_drafts_coach.sql
alter table reply_drafts add column if not exists mode      text not null default 'auto';
alter table reply_drafts add column if not exists gist      text;
alter table reply_drafts add column if not exists read_text text;
create index if not exists reply_drafts_coach_sent_idx on reply_drafts (moment, sent_at) where mode = 'coach' and sent_at is not null;
