-- Second phone numbers on a Relationships card (briefs/BRIEF_relationships_second_phone_2026-10-15.md).
-- `phone` stays the one number the Call/Text buttons dial. `alt_phones` holds
-- the other numbers we know them by (E.164, "+1" + 10 digits) so an inbound
-- call/text/email number lands on the existing card instead of a nameless
-- placeholder. Written and matched only by code; never auto-swapped.
--
-- Applied from the Mac mini: node scripts/run-migration.mjs supabase/migrations/2026-10-15_relationships_alt_phones.sql
alter table relationships add column if not exists alt_phones text[] not null default '{}';
create index if not exists relationships_alt_phones_gin_idx on relationships using gin (alt_phones);
