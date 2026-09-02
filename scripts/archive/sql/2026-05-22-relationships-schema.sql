-- Relationships (Book of Business) migration — Phase 1: schema
-- Brief: briefs/RELATIONSHIPS_SUPABASE_MIGRATION.md §3
-- Moves the BoB Google Sheet onto Supabase. Idempotent — safe to re-run.

-- relationships — the Book of Business, one row per contact.
create table if not exists relationships (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  phone             text,                       -- E.164 (+1XXXXXXXXXX)
  email             text,
  category          text not null
                      check (category in ('Agent','Vendor','Personal',
                        'PM','Investor','PrivateMoney','Seller')),
  tier              text not null default 'C'
                      check (tier in ('A','B','C','D','E')),
  notes             text,
  enriched_at       timestamptz,                -- replaces [enriched:] prefix
  last_contacted_at timestamptz,                -- replaces Sheet1 col G
  snooze_until      timestamptz,                -- replaces Sheet1 col J
  source_lead_id    uuid references leads(id),  -- the lead this came from
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists relationships_phone_idx        on relationships (phone);
create index if not exists relationships_category_idx     on relationships (category);
create index if not exists relationships_source_lead_idx  on relationships (source_lead_id);

-- relationship_touches — replaces the BoB "Log" tab. One row per logged
-- outreach (sent / skipped / etc.). Preserves generated_message for the
-- in-code "future voice-learning analysis".
create table if not exists relationship_touches (
  id                uuid primary key default gen_random_uuid(),
  relationship_id   uuid references relationships(id),
  occurred_at       timestamptz not null default now(),
  modality          text,            -- imessage / email / call
  action            text,            -- sent / skipped
  message           text,
  generated_message text,            -- original AI draft, for voice-learning
  was_edited        boolean,
  tier_at_touch     text,            -- snapshot at time of touch
  category_at_touch text             -- snapshot at time of touch
);
create index if not exists relationship_touches_rel_idx
  on relationship_touches (relationship_id, occurred_at desc);

-- Keep updated_at honest on relationships.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists relationships_set_updated_at on relationships;
create trigger relationships_set_updated_at
  before update on relationships
  for each row execute function set_updated_at();
