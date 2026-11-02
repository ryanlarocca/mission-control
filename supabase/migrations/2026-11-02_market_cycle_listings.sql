-- Market-cycle tracker, Phase 1 (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md, Part 4).
--
-- 1. cycle_listing_snapshots: every MLSListings Buy card (Active / Active Under
--    Contract / Contingent / Pending, all property types) for every geography,
--    once per weekly run. scripts/market-cycle/collect-weekly.py detects price
--    cuts (price below first_seen_price / below last week's price), withdrawals
--    and relists, and the list price behind list-to-sale, from these rows.
--    address is kept for relist detection (same address, new MLS #).
-- 2. cycle_tripwire_events: one row per big tripwire firing
--    (scripts/market-cycle/tripwires.py). Unique on (tripwire_id, fired_on) so
--    a weekly re-run never re-fires or re-posts the same crossing.
-- 3. cycle_owned_properties.sqft: the home value estimate (sqft x 90-day sold
--    $/sf) needs it; null = skipped.
--
-- Service-role only (RLS on, no policies) like every other internal table.
-- Idempotent: safe to re-run.

-- 1. Listing snapshots -------------------------------------------------------------
create table if not exists public.cycle_listing_snapshots (
  mls               text not null,
  geography         text not null,                 -- fetch group: scc | san_mateo | sf | santa_cruz | fremont
  zip               text,
  price             numeric,                       -- list price on the card that week
  status            text,                          -- Active | Active Under Contract | Contingent | Pending
  days_on_site      int,
  type              text,                          -- card type, e.g. 'Single Family Residence', 'Condominium'
  week              date not null,                 -- run date of the weekly collector
  first_seen_price  numeric,                       -- price the first time we saw this MLS #
  address           text,
  created_at        timestamptz not null default now(),
  unique (mls, week)
);
alter table public.cycle_listing_snapshots add column if not exists address text;
create index if not exists cycle_listing_snapshots_week_idx on public.cycle_listing_snapshots (week, geography);
create index if not exists cycle_listing_snapshots_zip_idx on public.cycle_listing_snapshots (zip, week);
comment on table public.cycle_listing_snapshots is 'Market-cycle weekly MLSListings snapshot: one row per Buy card per weekly run. Price-cut share, withdrawn/relist share and list-to-sale are computed from consecutive weeks.';
alter table public.cycle_listing_snapshots enable row level security;

-- 2. Tripwire events ---------------------------------------------------------------
create table if not exists public.cycle_tripwire_events (
  id                serial primary key,
  tripwire_id       text not null,                 -- config tripwires.big[].id
  dial_id           text,                          -- the dial whose reading crossed (null for claim_early)
  fired_on          date not null,                 -- as_of of the reading that completed the crossing
  reading           numeric,
  detail            text,                          -- the 3-line card + evaluation detail
  posted_at         timestamptz,                   -- Telegram card delivered
  review_requested  boolean not null default true, -- out-of-cycle review owed within 24h
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now()
);
create unique index if not exists cycle_tripwire_events_once_idx on public.cycle_tripwire_events (tripwire_id, fired_on);
comment on table public.cycle_tripwire_events is 'Market-cycle big-tripwire firings. Each row owes an out-of-cycle review (review_requested) until reviewed_at is set.';
alter table public.cycle_tripwire_events enable row level security;

-- 3. Owned-property square footage -------------------------------------------------
alter table public.cycle_owned_properties add column if not exists sqft int;
comment on column public.cycle_owned_properties.sqft is 'Living area; drives the rough value estimate (sqft x 90-day SFR sold $/sf in the zip). Null = no estimate.';
