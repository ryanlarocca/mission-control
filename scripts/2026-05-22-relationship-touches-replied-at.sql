-- Reply-rate tracking — Phase 1. Brief: briefs/RELATIONSHIPS_REPLY_TRACKING.md
-- replied_at = timestamp of the first inbound reply within 7 days of a sent
-- touch (null = no reply detected). Populated by the reply-detection script.
-- Idempotent.
alter table relationship_touches add column if not exists replied_at timestamptz;
create index if not exists relationship_touches_replied_idx
  on relationship_touches (replied_at);
