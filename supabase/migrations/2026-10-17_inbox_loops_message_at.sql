-- Inbox Agent — loop hygiene (briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md).
-- Idempotent. RLS is already on for inbox_loops; nothing here touches it.

-- Part A: resolution compares sent mail against the EMAIL's date, not the row's.
alter table inbox_loops add column if not exists message_at timestamptz;
comment on column inbox_loops.message_at is 'internalDate of the email that opened/refreshed the loop; resolution compares sent mail against this, not created_at';
update inbox_loops l
   set message_at = m.internal_date
  from inbox_messages m
 where m.gmail_id = l.gmail_id
   and l.message_at is null;

-- Part D: one ask = one loop. `${vendorFamily}|${propertyKey}|${askKind}`; a second
-- email for the same key within 48 h refreshes the loop instead of opening another.
alter table inbox_loops add column if not exists loop_key text;
comment on column inbox_loops.loop_key is 'vendorFamily|propertyKey|askKind (loops.mjs loopKey); upsertLoop refreshes an open/snoozed loop with the same key from the last 48 h';
create index if not exists inbox_loops_key_idx on inbox_loops (loop_key) where loop_key is not null;

-- Part F: who holds the next action. null is read as 'ryan'.
alter table inbox_loops add column if not exists owed_by text;
comment on column inbox_loops.owed_by is 'ryan | them — who holds the next action; them = the brief''s "Waiting on them" block (classifier owed_by, or Ryan replying theirs / mine on the card)';
alter table inbox_loops drop constraint if exists inbox_loops_owed_by_check;
alter table inbox_loops add constraint inbox_loops_owed_by_check check (owed_by is null or owed_by in ('ryan', 'them'));

-- Part H: how the ask gets resolved. 'portal' = only completable outside email (tapinspect
-- portal, a vendor e-sign page, a FreshBooks pay link); the brief asks about it ONCE, then
-- status 'asked' (not re-listed, not counted; still closed by a completion or a reply).
alter table inbox_loops add column if not exists resolution text;
comment on column inbox_loops.resolution is 'portal | email (loops.mjs resolutionKind) — portal asks are asked about once in the brief, then parked as status asked';
alter table inbox_loops drop constraint if exists inbox_loops_resolution_check;
alter table inbox_loops add constraint inbox_loops_resolution_check check (resolution is null or resolution in ('portal', 'email'));

-- resolved_by_event now also covers vendor completions (HomeSentry paid / results updated /
-- report filed, FreshBooks $0.00), not only DocuSign "Completed". asked = a portal ask the
-- brief raised once (Part H).
comment on column inbox_loops.status is 'open | done | snoozed | acknowledged | asked | resolved_by_reply | resolved_by_event | expired';
