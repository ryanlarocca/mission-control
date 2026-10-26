-- iPhone call log mirror (Ryan 2026-10-26: "I want you to be able to see my
-- call logs and how long I was on the phone with each person").
--
-- One row per call in the iPhone's call history, which syncs to the Mac mini
-- via "Calls on Other Devices" (CallHistoryDB/CallHistory.storedata).
-- scripts/sync-iphone-calls.mjs (launchd, every 5 min) upserts rows here, then
-- logs each new call onto the matching card:
--   Relationships → relationship_touches (modality='call')
--   Leads         → a leads row (lead_type='call')
-- System click-to-call / forwarded calls ring Ryan's cell FROM a Twilio line,
-- so they appear here too — kind='business_line', never logged twice.

create table if not exists public.phone_calls (
  id text primary key,                 -- ZUNIQUE_ID from CallHistory
  occurred_at timestamptz not null,
  phone text,                          -- E.164 when parseable, else the raw address
  direction text not null check (direction in ('outgoing', 'incoming')),
  answered boolean not null default false,
  duration_sec integer not null default 0,
  service text,                        -- com.apple.Telephony, FaceTime, third-party VoIP
  -- business_line | relationship | lead | both | unknown | skipped
  kind text,
  relationship_id uuid references public.relationships(id) on delete set null,
  relationship_category text,
  lead_cluster_phone text,
  touch_id uuid,
  lead_row_id uuid,
  skip_reason text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists phone_calls_occurred_at_idx on public.phone_calls (occurred_at desc);
create index if not exists phone_calls_unprocessed_idx on public.phone_calls (occurred_at) where processed_at is null;

alter table public.phone_calls enable row level security;
