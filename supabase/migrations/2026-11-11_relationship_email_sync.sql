-- Email with Relationships contacts lands on the card (2026-11-11,
-- briefs/BRIEF_RELATIONSHIP_EMAIL_SYNC_2026-11-11.md). Until now a card only
-- learned about email from the card's own Send button; anything Ryan sent or
-- received in Gmail on ryan@ never reached it. The Mac-mini inbox agent now
-- posts those messages to /api/crms/email-sync (lib/relationshipEmailSync.ts).
--
--   relationship_touches.gmail_message_id  the Gmail message a touch is —
--                                          the watcher's idempotency key, and
--                                          what a card send writes so the
--                                          watcher doesn't log it twice
--   relationship_touches.gmail_thread_id   its Gmail thread (ryan@), so the
--                                          card's Reply answers in their thread
--   relationships.texts_noted_through      newest cell text read for notes
--                                          when the card was opened (null =
--                                          never; the first open starts the
--                                          clock and reads no history)
--
-- Apply BEFORE the code that writes these columns deploys.
-- Idempotent — safe to re-run.
alter table relationship_touches add column if not exists gmail_message_id text;
alter table relationship_touches add column if not exists gmail_thread_id text;
-- One touch per Gmail message per card. Partial: the ~1k older touches (and
-- every text / call) have no Gmail id.
create unique index if not exists relationship_touches_rel_gmail_message_uniq
  on relationship_touches (relationship_id, gmail_message_id)
  where gmail_message_id is not null;
alter table relationships add column if not exists texts_noted_through timestamptz;
