-- One-off lead review screens (first use 2026-11-23: the people leaving
-- Long-term nurture). One row per person per batch; Ryan taps a decision on
-- /leads/review and the row records it. Nothing here moves a lead — the
-- picks are applied afterwards, on his say-so.
create table if not exists public.lead_review_picks (
  id            bigint generated always as identity primary key,
  batch         text not null,
  person_key    text not null,          -- caller_phone, or email for email-only people
  phone         text,
  email         text,
  name          text,
  address       text,
  sort_order    int not null default 0,
  planned_date  date,                   -- the date proposed in chat
  judge_guess   text,                   -- watch-only judge run, never applied
  decision      text,                   -- followup | autopilot | leave | dead
  decision_date date,                   -- with decision = followup
  note          text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (batch, person_key)
);

alter table public.lead_review_picks enable row level security;
-- No policies on purpose: only the service role (the app's API routes) reads or writes.
