-- Inbox Agent — documents behind links (briefs/BRIEF_INBOX_LINK_FETCH_2026-10-12.md).
-- One row per distinct URL the agent is asked to open (DocuSign first); the
-- Mac mini worker runs the browser, Vercel only writes queue rows. Fetched
-- files land in inbox_files like attachments, tagged by source + fetch_id.
-- Service-role only (RLS on, no policies) like every other inbox_* table.

create table if not exists inbox_fetches (
  id            uuid primary key default gen_random_uuid(),
  gmail_id      text references inbox_messages (gmail_id) on delete cascade,
  thread_id     text,
  url           text not null,
  url_sha256    text not null,
  provider      text not null,                   -- 'docusign' | 'unknown'
  kind          text,                            -- the inbox_messages.kind that queued it, or 'manual'
  status        text not null default 'queued',  -- queued | running | done | failed | needs_code | needs_login | expired | duplicate
  access_code   text,
  attempts      int not null default 0,
  next_try_at   timestamptz,
  error         text,
  files         jsonb not null default '[]'::jsonb,   -- [{filename, mime, size, sha256, inbox_file_id}]
  screenshot    text,
  tg_message_id bigint,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  resolved_at   timestamptz
);
create unique index if not exists inbox_fetches_url_once on inbox_fetches (url_sha256);
create index if not exists inbox_fetches_status_idx on inbox_fetches (status);
create index if not exists inbox_fetches_gmail_idx on inbox_fetches (gmail_id);
create index if not exists inbox_fetches_tg_idx on inbox_fetches (tg_message_id) where tg_message_id is not null;
alter table inbox_fetches enable row level security;

alter table inbox_files add column if not exists source text not null default 'attachment';   -- 'attachment' | 'docusign' | 'manual'
alter table inbox_files add column if not exists fetch_id uuid references inbox_fetches (id) on delete set null;
create index if not exists inbox_files_fetch_idx on inbox_files (fetch_id) where fetch_id is not null;
