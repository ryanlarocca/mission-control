-- One event per Gmail message: two concurrent Pub/Sub notifications can race
-- past the alreadyProcessed check (Anne Wilbur double-alerted 2026-07-20).
-- Clean existing duplicates (keep the earliest), then enforce uniqueness;
-- the pipeline treats a duplicate-key failure as "already handled" and
-- skips the alert.
delete from campaign_events e
using campaign_events keep
where e.raw->>'gmail_id' is not null
  and keep.raw->>'gmail_id' = e.raw->>'gmail_id'
  and keep.occurred_at < e.occurred_at;

create unique index if not exists campaign_events_gmail_id_uniq
  on campaign_events ((raw->>'gmail_id'))
  where raw->>'gmail_id' is not null;
