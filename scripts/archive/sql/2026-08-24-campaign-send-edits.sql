-- Voice learning (2026-08-24): keep every before/after pair when Ryan edits a
-- draft in /email-campaign. The PATCH route used to overwrite body and just
-- flip `edited`, so the original was lost. These rows feed the compose
-- prompt as few-shot corrections (Phase B copy-quality work).
create table if not exists campaign_send_edits (
  id uuid primary key default gen_random_uuid(),
  send_id uuid not null references campaign_sends(id) on delete cascade,
  contact_id uuid references campaign_contacts(id) on delete set null,
  touch_number int,
  variant text,
  subject_before text,
  subject_after text,
  body_before text,
  body_after text,
  created_at timestamptz not null default now()
);
create index if not exists campaign_send_edits_created_idx on campaign_send_edits (created_at desc);
alter table campaign_send_edits enable row level security;
