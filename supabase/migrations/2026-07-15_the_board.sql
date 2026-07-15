-- The Board — 90-day goal & rep tracker (LRG CRMS project)
-- Lives in the LRG project (not Physiq) so contact touches can carry a real
-- FK to relationships(id) for later conversation-to-offer analysis.
-- Access is server-side only via getLeadsClient() (service role); RLS is
-- enabled with NO policies = default-deny for anon/authenticated, matching
-- leads / relationships / campaigns.

-- board_periods: one row per goal block (configurable; the app targets the
-- period containing "today", falling back to the most recent one).
create table if not exists public.board_periods (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  starts_on  date not null,
  ends_on    date not null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);

-- board_events: append-only rep log. One row per logged rep; every quota and
-- stat is a fold over these rows, so undo = delete row. payload shapes:
--   contact_touch  {bucket: 'agent'|'seller'|'referral_partner'}
--   offer          {}
--   draft          {wins: int, losses: int}
--   dg_round       {over_par: int}
--   dg_practice    {}
--   cage           {}
--   softball_game  {pa: ['1B'|'2B'|'3B'|'HR'|'BB'|'SF'|'K'|'OUT', ...]}
create table if not exists public.board_events (
  id              uuid primary key default gen_random_uuid(),
  period_id       uuid not null references public.board_periods(id) on delete cascade,
  event_type      text not null check (event_type in
                    ('contact_touch','offer','draft','dg_round','dg_practice','cage','softball_game')),
  occurred_on     date not null,   -- client-local calendar day (Ryan's tz, not server UTC)
  payload         jsonb not null default '{}'::jsonb,
  relationship_id uuid references public.relationships(id),
  created_at      timestamptz not null default now()
);

create index if not exists board_events_period_date_type_idx
  on public.board_events (period_id, occurred_on desc, event_type);
create index if not exists board_events_rel_idx
  on public.board_events (relationship_id) where relationship_id is not null;

alter table public.board_periods enable row level security;
alter table public.board_events  enable row level security;

grant all on table public.board_periods to service_role;
grant all on table public.board_events  to service_role;

-- Seed the first 90-day block only if no period exists yet.
insert into public.board_periods (label, starts_on, ends_on)
select '90-Day Block · Jul 15 → Oct 13', date '2026-07-15', date '2026-10-13'
where not exists (select 1 from public.board_periods);
