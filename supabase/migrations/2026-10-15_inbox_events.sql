-- Inbox Agent — networking-event watcher (briefs/BRIEF_EVENT_WATCHER_2026-10-15.md).
-- One row per real-world event (organizer + date + city), however many reminder
-- emails announce it. Status drives the morning brief + Telegram cards:
--   new            detected, not yet shown
--   alerted        card posted with the brief (✓ Done / 📅 Add to calendar / 🚫 Not interested)
--   acknowledged   Ryan tapped Done, or the event was already on his calendar
--   add_requested  Ryan tapped Add to calendar; the Mac mini worker creates it next pass
--   added          on the info@lrghomes.com calendar
--   dismissed      Ryan tapped Not interested
-- Service-role only (RLS on, no policies) like every other inbox_* table.

create table if not exists inbox_events (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  organizer         text,
  organizer_family  text,                      -- dedupe slug: 'conventus', 'sanjosereal' (meetup group), sender domain…
  event_date        date not null,
  start_time        text,                      -- 'HH:MM' local, null when the email gave none
  end_time          text,
  venue             text,
  address           text,
  city              text,
  cost              text,
  rsvp_url          text,
  why               text,                      -- one line: who's likely in the room
  verdict           text not null default 'include',   -- include | borderline
  borderline_reason text,
  source_mailbox    text not null,             -- 'ryan@lrghomes.com' | 'ryanlarocca9@gmail.com'
  source_ids        text[] not null default '{}',      -- gmail ids / imap uids that announced it
  source_link       text,                      -- open the first email
  email_count       int not null default 1,
  details           jsonb not null default '{}'::jsonb, -- full model output of the latest email, for audit
  details_hash      text,                      -- name|date|start|venue|address|cost — a change re-surfaces the event once
  details_changed   boolean not null default false,
  status            text not null default 'new',
  on_calendar       boolean not null default false,
  calendar_event_id text,
  calendar_link     text,
  tg_message_id     bigint,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  alerted_at        timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists inbox_events_date_idx on inbox_events (event_date);
create index if not exists inbox_events_status_idx on inbox_events (status);
create index if not exists inbox_events_tg_idx on inbox_events (tg_message_id) where tg_message_id is not null;
alter table inbox_events enable row level security;
