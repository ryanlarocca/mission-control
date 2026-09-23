-- Relationships tab click-to-call (2026-09-23). A call placed from the card
-- is a relationship_touches row (modality='call') that Twilio's callbacks
-- fill in as the call progresses; the transcript summary lands in `message`
-- (what Log Call writes by hand) and the full transcript in `transcript`.
alter table relationship_touches add column if not exists call_sid          text;
alter table relationship_touches add column if not exists call_status       text;   -- dialing | completed | no-answer | busy | failed | canceled
alter table relationship_touches add column if not exists call_duration_sec integer;
alter table relationship_touches add column if not exists recording_url     text;
alter table relationship_touches add column if not exists transcript        text;
create index if not exists relationship_touches_call_sid_idx on relationship_touches (call_sid) where call_sid is not null;
