-- Market-cycle tracker, Phase 0 (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md).
--
-- The thesis (scenarios, 32 claims, dial registry, calendar) is a versioned
-- config file in the repo: config/market-cycle/thesis.v1.1.json. These tables
-- hold what changes over time: the claims' live probabilities and scores,
-- the dial registry with its computed corridors, append-only readings, the
-- checkpoints, the weight-move log, the owned-property registry and the data
-- calendar. scripts/market-cycle/bootstrap-history.py --write seeds them.
--
-- Service-role only (RLS on, no policies) like every other internal table.
-- Idempotent: safe to re-run.

-- 1. Thesis versions -----------------------------------------------------------
create table if not exists public.cycle_thesis_versions (
  version     text primary key,                 -- '1.1'
  date        date not null,
  config      jsonb not null,                   -- the full thesis.vX.json
  created_at  timestamptz not null default now()
);
comment on table public.cycle_thesis_versions is 'Market-cycle thesis versions. config = the full config/market-cycle/thesis.vX.json as committed; git history is the human version log.';
alter table public.cycle_thesis_versions enable row level security;

-- 2. Claims ----------------------------------------------------------------------
create table if not exists public.cycle_claims (
  id             text primary key,              -- 'C1'..'C32'
  version        text not null,                 -- thesis version the text belongs to
  text           text not null,
  category       text not null,                 -- macro | rates | credit | scc_housing | local_labor | ai_liquidity
  scenario_tag   text not null check (scenario_tag in ('bear','base','bull')),
  prob_initial   numeric not null check (prob_initial between 0 and 100),
  prob_current   numeric not null check (prob_current between 0 and 100),
  resolves_on    date not null,
  falsifier      text not null,
  data_source    text not null,                 -- dial id, 'event' or 'manual'
  status         text not null default 'open' check (status in ('open','resolved','void')),
  resolution     boolean,                       -- null until resolved; true = claim came true
  resolved_at    timestamptz,
  brier_live     numeric,                       -- on the probability held at the last monthly checkpoint before resolution
  brier_initial  numeric,                       -- on prob_initial
  updated_at     timestamptz not null default now()
);
comment on table public.cycle_claims is 'Market-cycle claims (discrete, dated, scoreable). Text changes only at quarterly rewrites; prob_current may move at any monthly checkpoint (each move logged on the checkpoint). Both Brier scores filled on resolution.';
alter table public.cycle_claims enable row level security;

-- 3. Dial registry ---------------------------------------------------------------
create table if not exists public.cycle_dials (
  id             text primary key,
  name           text not null,
  cadence        text not null check (cadence in ('daily','weekly','monthly','quarterly','event')),
  category       text not null,
  source         jsonb not null default '{}'::jsonb,   -- {name, series_id?, url}
  fetch_method   text not null,                        -- registry "fetch": fred_csv | zillow_csv | edd_warn_xlsx | apartmentlist | nasdaq_api | ...
  units          text,
  transform      text not null default 'level',
  direction_map  jsonb not null,                       -- {"up": "bear"|"bull"|"neutral", "down": ...}
  band_rule      text not null check (band_rule in ('seasonal_1sd','corridor','event')),
  corridor       jsonb,                                -- computed by the bootstrap / set at the shakedown
  has_history    boolean not null default false,
  votes          boolean not null default true,        -- false = context only (panels, owned zips)
  geography      text,
  notes          text,
  updated_at     timestamptz not null default now()
);
comment on table public.cycle_dials is 'Market-cycle dial registry, mirrored from the thesis config. direction_map says which scenario an up / down move favours; corridor holds the band numbers computed from each series'' own history.';
alter table public.cycle_dials enable row level security;

-- 4. Readings (append-only) ------------------------------------------------------
create table if not exists public.cycle_readings (
  id          bigserial primary key,
  dial_id     text not null references public.cycle_dials(id) on delete cascade,
  as_of       date not null,
  value       numeric,
  source_url  text not null default '',
  raw         text,                                     -- raw snippet / source row for audit
  created_at  timestamptz not null default now(),
  unique (dial_id, as_of, source_url)
);
create index if not exists cycle_readings_dial_asof_idx on public.cycle_readings (dial_id, as_of desc);
comment on table public.cycle_readings is 'Market-cycle readings: one row per dial per as-of date per source. value is in the dial''s units (after its transform). Append-only; a revised print lands as an upsert on the same key.';
alter table public.cycle_readings enable row level security;

-- 5. Checkpoints -----------------------------------------------------------------
create table if not exists public.cycle_checkpoints (
  id                   uuid primary key default gen_random_uuid(),
  date                 date not null,
  kind                 text not null check (kind in ('shakedown','monthly','quarterly','tripwire')),
  weights_before       jsonb,
  weights_after        jsonb,
  votes                jsonb,                           -- dials that voted, by category
  argument             text,
  opposite_case        text,
  claims_resolved      jsonb,                           -- resolutions + re-probabilisations
  next_dates           jsonb,
  telegram_message_id  text,
  ryan_note            text,                            -- the "Disagree" force-reply
  created_at           timestamptz not null default now()
);
create index if not exists cycle_checkpoints_date_idx on public.cycle_checkpoints (date desc);
comment on table public.cycle_checkpoints is 'Market-cycle reviews: shakedown, monthly (Monday after CPI), quarterly rewrite, tripwire. One row per review with the card''s Telegram id and Ryan''s Disagree note.';
alter table public.cycle_checkpoints enable row level security;

-- 6. Weight-move log -------------------------------------------------------------
create table if not exists public.cycle_weight_moves (
  id                   serial primary key,
  checkpoint_id        uuid references public.cycle_checkpoints(id) on delete set null,
  date                 date not null,
  from_weights         jsonb not null,
  to_weights           jsonb not null,
  readings_cited       jsonb,                           -- >= 2 readings (move #0 excepted as bootstrap)
  argument             text not null,
  opposite_case        text not null,
  reverses_if          text,
  bootstrap_exception  boolean not null default false,
  created_at           timestamptz not null default now()
);
comment on table public.cycle_weight_moves is 'The artifact: every change to the bear/base/bull weights. No weight moves without a row; a row cites at least two readings and a non-empty opposite case (move #0 = bootstrap exception).';
alter table public.cycle_weight_moves enable row level security;

-- 7. Owned-property registry -----------------------------------------------------
create table if not exists public.cycle_owned_properties (
  id          uuid primary key default gen_random_uuid(),
  address     text,                                     -- null allowed (the home row until Ryan fills it)
  zip         text not null,
  flag        text not null check (flag in ('for_sale','held','home')),
  bought_on   date,
  listed_on   date,
  sold_on     date,
  source      text,                                     -- bootstrap | settlement_statement | listing_agreement | mls | telegram
  created_at  timestamptz not null default now(),
  retired_at  timestamptz
);
create index if not exists cycle_owned_properties_zip_idx on public.cycle_owned_properties (zip) where retired_at is null;
comment on table public.cycle_owned_properties is 'Properties Ryan owns, drives which zips the weekly collector watches (95118 home permanently). Maintained by the inbox agent''s settlement-statement filing with a Telegram fallback. Ground truth, never a vote.';
alter table public.cycle_owned_properties enable row level security;

-- 8. Data calendar ---------------------------------------------------------------
create table if not exists public.cycle_calendar (
  id         serial primary key,
  date       date,                                      -- null = TBD
  label      text not null,
  dial_id    text references public.cycle_dials(id) on delete set null,
  tentative  boolean not null default false,
  fired_at   timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists cycle_calendar_date_idx on public.cycle_calendar (date);
comment on table public.cycle_calendar is 'Scheduled releases (jobs, CPI, FOMC, Case-Shiller, PCE, lockups, earnings), each tagged with the dial it feeds. date null = TBD.';
alter table public.cycle_calendar enable row level security;
