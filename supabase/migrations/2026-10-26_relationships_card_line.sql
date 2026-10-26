-- "Card #" toggle on a Relationships card (briefs/BRIEF_relationships_card_line_2026-10-26.md).
-- `use_card_line` = calls and texts to this contact go out from the business-
-- card line (408) 458-5442 instead of Ryan's cell, so their callbacks land on
-- a line we capture. Default OFF for everyone — no backfill (Ryan's call).
-- `twilio_number` on a touch = the Twilio line a text/call went out from or
-- came in on, so the card's Messages box can show business-line texts that
-- chat.db never sees.
--
-- Applied from the Mac mini: node scripts/run-migration.mjs supabase/migrations/2026-10-26_relationships_card_line.sql
alter table relationships add column if not exists use_card_line boolean not null default false;
-- The Twilio line a text/call went out from or came in on (E.164). Null =
-- Ryan's own phone (iMessage sidecar / verified cell) or unknown (old rows).
alter table relationship_touches add column if not exists twilio_number text;
