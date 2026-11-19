-- Pin on a Relationships contact (Ryan 2026-11-18): someone who handed him a
-- lead gets pinned so they sit at the top of the Relationships tab and he
-- keeps calling until the lead is sorted. No cadence, no reminders: just the pin.
--   pinned_at  when he pinned them; null = not pinned. Pinned contacts show
--              in the tab's Pinned section every day and skip the due queue.
--   pin_note   his optional few words about the lead ("Santana Row lead").
--
-- relationships already has RLS on; new columns inherit it.
-- Applied from the Mac mini: node scripts/run-migration.mjs supabase/migrations/2026-11-18_relationship_pin.sql
alter table public.relationships add column if not exists pinned_at timestamptz;
alter table public.relationships add column if not exists pin_note text;
