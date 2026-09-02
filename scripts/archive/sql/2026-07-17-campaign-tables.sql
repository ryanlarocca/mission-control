-- Agent email drip campaign — core tables (Phase 2 of
-- briefs/EMAIL_DRIP_CAMPAIGN_2026-07-17.md).
--
-- campaign_contacts: one row per person from the raw agent list, plus
--   lifecycle state for the 12-month drip.
-- campaign_sends:    one row per drafted/sent email (the approval queue).
-- campaign_events:   one row per engagement event (replies, calls, texts,
--   voicemails, bounces, notes) — the per-contact timeline.

create table if not exists campaign_contacts (
  id uuid primary key default gen_random_uuid(),
  name text,
  first_name text,
  last_name text,
  email text,                 -- lowercased primary send address
  alt_emails text[] not null default '{}',
  phone text,                 -- last-10 digits
  alt_phones text[] not null default '{}',
  phone_bad boolean not null default false,  -- CRM said Bad Number/Disconnected
  property_address text,      -- from the dialer CRM (their canceled listing)
  status text not null default 'active'
    check (status in ('active', 'paused', 'replied', 'bounced', 'unsubscribed',
                      'suppressed', 'bad_email', 'no_email')),
  touch_number int not null default 0,      -- last touch SENT
  next_touch_at timestamptz,                -- when the next touch is due
  last_sent_at timestamptz,
  gmail_thread_id text,                     -- thread of the most recent touch
  soft_bounces int not null default 0,
  crm_last_call_result text,
  crm_email_status text,
  crm_notes text,
  import_flags text[] not null default '{}', -- active_lead / relationships_overlap / merged / review
  raw jsonb,                                 -- original spreadsheet row
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists campaign_contacts_email_uniq
  on campaign_contacts (lower(email)) where email is not null;
create index if not exists campaign_contacts_phone_idx on campaign_contacts (phone);
create index if not exists campaign_contacts_due_idx
  on campaign_contacts (next_touch_at) where status = 'active';
create index if not exists campaign_contacts_thread_idx
  on campaign_contacts (gmail_thread_id) where gmail_thread_id is not null;

create table if not exists campaign_sends (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references campaign_contacts (id) on delete cascade,
  touch_number int not null,
  subject text not null,
  body text not null,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'sent', 'skipped', 'failed')),
  scheduled_for timestamptz,
  sent_at timestamptz,
  gmail_message_id text,
  gmail_thread_id text,
  approved_at timestamptz,
  edited boolean not null default false,    -- Ryan changed the AI draft (voice-learning signal)
  error text,
  created_at timestamptz not null default now()
);

create index if not exists campaign_sends_status_idx on campaign_sends (status, created_at);
create index if not exists campaign_sends_contact_idx on campaign_sends (contact_id);
-- One pending draft per contact per touch (re-runs of the engine must not
-- stack duplicate drafts).
create unique index if not exists campaign_sends_draft_uniq
  on campaign_sends (contact_id, touch_number)
  where status in ('draft', 'approved');

create table if not exists campaign_events (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references campaign_contacts (id) on delete set null,
  kind text not null
    check (kind in ('email_reply', 'email_out', 'sms_in', 'sms_out', 'call_answered',
                    'call_missed', 'voicemail', 'note', 'bounce', 'unsubscribe')),
  caller_number text,        -- for phone events (last-10)
  body text,                 -- message text / transcript / note
  duration_seconds int,
  ai_summary text,
  triage text,               -- interested / question / not_now / remove_me / auto_reply
  handled_at timestamptz,
  occurred_at timestamptz not null default now(),
  raw jsonb
);

create index if not exists campaign_events_contact_idx on campaign_events (contact_id, occurred_at desc);
create index if not exists campaign_events_unhandled_idx
  on campaign_events (occurred_at desc) where handled_at is null;
