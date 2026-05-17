-- 2026-05-17 — drip snooze column.
-- Adds snoozed_until to drip_queue so Ryan can push a pending touch out by
-- 1/3/7 days from the Drips tab without skipping it. The Drips API filters
-- rows where snoozed_until > now() out of Late/Due/Coming up; once the
-- snooze expires the row reappears in Due. Touch number is unchanged.
-- Idempotent: safe to re-run.

ALTER TABLE drip_queue ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ NULL;
CREATE INDEX IF NOT EXISTS idx_drip_queue_snoozed_until ON drip_queue(snoozed_until) WHERE snoozed_until IS NOT NULL;
