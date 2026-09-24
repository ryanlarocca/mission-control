-- Reply Planner Phase 6: the weekly review marks whys it has surfaced so
-- each one is brought to Ryan once.
alter table reply_drafts add column if not exists reviewed_at timestamptz;
