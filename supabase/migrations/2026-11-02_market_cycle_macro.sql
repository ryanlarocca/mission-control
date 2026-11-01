-- Market-cycle tracker, workstream 3: daily macro collector
-- (scripts/market-cycle/collect-macro.py; briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md 3.3).
-- Needs 2026-11-01_market_cycle.sql applied first.
--
-- 1. cycle_notes: silent scheduled-release notes ("CPI printed 3.7 vs prior 3.4"),
--    written when a calendar dial (jobs, CPI, PCE, Case-Shiller, FOMC) gets a new
--    print; surfaced by the monthly card, which sets surfaced_at.
-- 2. cycle_readings.variant: a dial's corridor may read a derived series besides
--    the dial's own (10d_avg, 2d_close, drawdown_from_52w_high, yoy_pct, ...).
--    '' = the dial's own series. The unique key gains the variant.
--
-- Service-role only (RLS on, no policies) like every other internal table.
-- Idempotent: safe to re-run.

-- 1. Scheduled-release notes -------------------------------------------------------
create table if not exists public.cycle_notes (
  id           serial primary key,
  date         date not null,                                -- the day the collector saw the print
  dial_id      text references public.cycle_dials(id) on delete set null,
  text         text not null,                                -- 'X printed V (period) vs prior P (period)'
  kind         text not null default 'release',
  surfaced_at  timestamptz,                                  -- set by the monthly card
  created_at   timestamptz not null default now()
);
create unique index if not exists cycle_notes_dial_text_uidx on public.cycle_notes (dial_id, text);
create index if not exists cycle_notes_unsurfaced_idx on public.cycle_notes (date) where surfaced_at is null;
comment on table public.cycle_notes is 'Market-cycle silent notes. kind release = a scheduled release printed (written by collect-macro.py); surfaced by the monthly checkpoint card, which sets surfaced_at. Unique on (dial_id, text) so a re-run never duplicates.';
alter table public.cycle_notes enable row level security;

-- 2. Reading variants ----------------------------------------------------------------
alter table public.cycle_readings add column if not exists variant text not null default '';
comment on column public.cycle_readings.variant is 'Empty = the dial''s own series (its transform). Otherwise the derived series its corridor reads: 10d_avg, 2d_close, yoy_pct, drawdown_from_52w_high, drawdown_from_<date>_high.';
alter table public.cycle_readings drop constraint if exists cycle_readings_dial_id_as_of_source_url_key;
create unique index if not exists cycle_readings_dial_variant_asof_src_uidx
  on public.cycle_readings (dial_id, variant, as_of, source_url);
drop index if exists public.cycle_readings_dial_asof_idx;
create index if not exists cycle_readings_dial_variant_asof_idx on public.cycle_readings (dial_id, variant, as_of desc);
