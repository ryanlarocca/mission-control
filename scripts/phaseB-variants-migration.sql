-- Phase B (2026-08-21): variant tags, unique-body guard, evening batches, settings, variant templates
alter table campaign_sends
  add column if not exists variant text,
  add column if not exists body_hash text,
  add column if not exists batch_date text,
  add column if not exists sender text;
create unique index if not exists campaign_sends_body_hash_uniq
  on campaign_sends(body_hash) where body_hash is not null and status in ('approved','sent');
alter table campaign_contacts
  add column if not exists cohort text,
  add column if not exists variant text;
create table if not exists campaign_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists campaign_variants (
  variant text primary key,
  touch_number int not null,
  label text,
  subject text not null,
  body text not null,
  personalize boolean not null default false,
  updated_at timestamptz not null default now()
);
