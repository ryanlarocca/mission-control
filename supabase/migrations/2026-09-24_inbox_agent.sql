-- Inbox Agent (briefs/BRIEF_INBOX_AGENT_2026-09-24.md), Phase 1.
-- State for the ryan@lrghomes.com watcher: processed messages, attachment
-- filing proposals + Ryan's decisions, learned filing rules, the Drive
-- interview, open loops ("things Ryan owes someone"), and deal screens.
-- Service-role only (RLS on, no policies) like every other CRMS table.

create table if not exists inbox_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table inbox_settings enable row level security;

create table if not exists inbox_messages (
  gmail_id         text primary key,
  thread_id        text,
  mailbox          text not null default 'ryan@lrghomes.com',
  internal_date    timestamptz,
  sender           text,
  sender_name      text,
  subject          text,
  kind             text,            -- human | automated | docusign_request | docusign_completed | zix | deal_lead | broker_blast | skip
  classification   jsonb,           -- full model output, for audit
  attachment_count int not null default 0,
  status           text not null default 'processed',
  created_at       timestamptz not null default now()
);
create index if not exists inbox_messages_thread_idx on inbox_messages (thread_id);
create index if not exists inbox_messages_date_idx on inbox_messages (internal_date desc);
alter table inbox_messages enable row level security;

create table if not exists inbox_files (
  id               uuid primary key default gen_random_uuid(),
  gmail_id         text not null references inbox_messages (gmail_id) on delete cascade,
  thread_id        text,
  attachment_id    text,
  part_id          text,
  filename         text not null,
  mime             text,
  size_bytes       bigint,
  sha256           text,
  sender           text,
  subject          text,
  received_at      timestamptz,
  property_key     text,
  property_label   text,
  doc_type         text,
  confidence       numeric,
  proposed_folder  text,
  proposed_name    text,
  final_folder     text,
  final_name       text,
  drive_file_id    text,
  drive_folder_id  text,
  drive_url        text,
  -- pending | approved | change_requested | changed | skipped | filed | duplicate | error | interview | waiting
  status           text not null default 'pending',
  mode             text not null default 'training',   -- training | auto
  rule_id          uuid,
  change_text      text,
  error            text,
  tg_message_id    bigint,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  filed_at         timestamptz
);
create index if not exists inbox_files_tg_idx on inbox_files (tg_message_id) where tg_message_id is not null;
create index if not exists inbox_files_sha_idx on inbox_files (sha256);
create index if not exists inbox_files_status_idx on inbox_files (status);
alter table inbox_files enable row level security;

create table if not exists inbox_rules (
  id                uuid primary key default gen_random_uuid(),
  sender_domain     text,
  sender_email      text,
  doc_type          text,
  property_key      text,           -- null = any property
  folder_template   text not null,  -- e.g. "Business Operations/Properties/{property}"
  filename_template text not null,  -- e.g. "{property} {doc_type} {date}.pdf"
  approvals_in_row  int not null default 0,
  mode              text not null default 'manual',   -- manual | auto
  source            text,           -- interview | correction | approval
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_used_at      timestamptz
);
alter table inbox_rules enable row level security;

create table if not exists inbox_interview (
  id            uuid primary key default gen_random_uuid(),
  file_id       uuid references inbox_files (id) on delete cascade,
  seq           int,
  question      text,
  guess_folder  text,
  guess_name    text,
  answer_text   text,
  answer_kind   text,               -- accepted | custom | skipped
  status        text not null default 'pending',   -- pending | asked | answered | skipped
  tg_message_id bigint,
  asked_at      timestamptz,
  answered_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists inbox_interview_tg_idx on inbox_interview (tg_message_id) where tg_message_id is not null;
alter table inbox_interview enable row level security;

create table if not exists inbox_loops (
  id                 uuid primary key default gen_random_uuid(),
  thread_id          text,
  gmail_id           text,
  subject            text,
  counterparty       text,
  counterparty_email text,
  category           text,          -- escrow | lender | agent | contractor | tax | vendor | signature | personal | other
  ask                text,
  due_on             date,
  priority           text not null default 'normal',  -- high | normal | low
  status             text not null default 'open',    -- open | done | snoozed | resolved_by_reply | resolved_by_event | expired
  snooze_until       timestamptz,
  tg_message_id      bigint,
  alerted_at         timestamptz,
  last_digest_at     timestamptz,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz
);
create index if not exists inbox_loops_thread_idx on inbox_loops (thread_id);
create index if not exists inbox_loops_status_idx on inbox_loops (status);
create index if not exists inbox_loops_tg_idx on inbox_loops (tg_message_id) where tg_message_id is not null;
alter table inbox_loops enable row level security;

create table if not exists inbox_deal_screens (
  id            uuid primary key default gen_random_uuid(),
  gmail_id      text,
  file_id       uuid,
  address       text,
  tier          text,               -- direct | blast
  facts         jsonb,
  verdict       text,               -- pass | look_further | unknown
  summary       text,
  ryan_verdict  text,               -- look | pass
  tg_message_id bigint,
  created_at    timestamptz not null default now()
);
create index if not exists inbox_deal_screens_tg_idx on inbox_deal_screens (tg_message_id) where tg_message_id is not null;
alter table inbox_deal_screens enable row level security;
