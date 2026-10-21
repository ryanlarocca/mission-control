-- Email-lead dedupe becomes atomic (briefs/BRIEF_TRIAGE_SONNET_DEDUPE_MATCHLINK_2026-10-21.md §3).
-- Two Gmail notifications for one message raced through the read-then-insert
-- check and produced two identical rows 0.2 s apart. The unique index makes
-- the second insert fail with 23505, which the route treats as "already have
-- it". Idempotent. No new table, so no RLS change. No backfill needed.
--
-- Pub/Sub path stores the Gmail message id. The Apps Script path has none, so
-- it stores "as:" + sha1(sender|subject|first 200 chars of body) — same
-- index covers both.
alter table leads add column if not exists gmail_message_id text;
comment on column leads.gmail_message_id is 'Gmail message id (Pub/Sub path) or "as:<sha1>" (Apps Script path); unique when set — the second insert of the same message is rejected (23505) instead of duplicating the lead';
create unique index if not exists leads_gmail_message_id_uniq on leads (gmail_message_id) where gmail_message_id is not null;
