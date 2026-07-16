-- One-time backfill: give already-triaged "vague" contacts their 365-day
-- snooze, measured from when the verdict was recorded. Before this, a vague
-- contact whose last touch predated the tier-D cadence (5+ years ago for
-- most) became due again the moment it was demoted — Ryan's Cleanup pass
-- resurfaced in the daily queue same-day. New vague verdicts get the snooze
-- in the API route; this catches the ~140 recorded before the fix shipped.
-- Idempotent — the WHERE clause makes re-runs no-ops.

update relationships
set snooze_until = cleanup_reviewed_at + interval '365 days'
where cleanup_verdict = 'vague'
  and status = 'active'
  and cleanup_reviewed_at is not null
  and (snooze_until is null or snooze_until < cleanup_reviewed_at + interval '365 days');
