-- Inbox Agent — email drafts for deal cards (✉️ Reply). Ryan 2026-09-24:
-- "we need to be replying to these emails that are direct" — and to blasts
-- the filter surfaced. Every send is a tap; nothing auto-sends.
create table if not exists inbox_drafts (
  id             uuid primary key default gen_random_uuid(),
  screen_id      uuid,
  gmail_id       text,
  thread_id      text,
  to_email       text,
  to_name        text,
  subject        text,
  body           text not null,
  intent         text,              -- pass | look | custom
  instructions   text,              -- Ryan's edit instructions for this version
  version        int not null default 1,
  parent_id      uuid,
  status         text not null default 'draft',   -- draft | sent | dismissed | superseded
  tg_message_id  bigint,
  sent_gmail_id  text,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz
);
create index if not exists inbox_drafts_tg_idx on inbox_drafts (tg_message_id) where tg_message_id is not null;
create index if not exists inbox_drafts_screen_idx on inbox_drafts (screen_id);
alter table inbox_drafts enable row level security;
