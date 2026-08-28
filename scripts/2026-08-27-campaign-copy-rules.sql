-- Standing copy rules (2026-08-27): Ryan types a rule once in /email-campaign
-- ("never claim we've met") and every compose — regenerate, regenerate-all,
-- and the daily engine — reads the active rows into the prompt. Rules are
-- Ryan-authored only (edits are questions, not rules — 2026-08-24).
create table if not exists campaign_copy_rules (
  id uuid primary key default gen_random_uuid(),
  rule text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create index if not exists campaign_copy_rules_active_idx on campaign_copy_rules (active, created_at desc);
alter table campaign_copy_rules enable row level security;

-- The reason Ryan gave when he rejected a draft (regenerate-with-a-note).
alter table campaign_send_edits add column if not exists note text;
