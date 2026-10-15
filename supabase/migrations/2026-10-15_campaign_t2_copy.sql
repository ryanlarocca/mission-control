-- Touch-two copy (briefs/BRIEF_CAMPAIGN_AUTOPILOT_GATES_2026-10-14.md, Task 7).
-- Touches are event-based now (T2 starts only once T1 has gone to the whole
-- list), so "my note last month" can be months off. Reword to not name a gap;
-- nothing else changes. Ryan vetoes by not applying this file — the seed in
-- scripts/campaign-touches.mjs carries the same wording as the fallback.
-- Idempotent: a second run matches nothing.
--
-- Apply from the Mac mini:
--   node scripts/run-migration.mjs supabase/migrations/2026-10-15_campaign_t2_copy.sql

update campaign_templates
set body = replace(body, 'quick follow-up on my note last month', 'quick follow-up on my note from a while back')
where touch_number = 2
  and body like '%quick follow-up on my note last month%';
