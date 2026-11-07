-- Market-cycle thesis v1.2 (brief v2, Nov 7, 2026): two bets.
--   housing  SCC single-family drawdown (every row written before v1.2)
--   spx      S&P 500 drawdown from the Oct 6, 2026 high + timing (new)
-- Claims, weight moves and tripwire events say which bet they belong to; a
-- review stays ONE checkpoint row (one card, one Disagree) and keeps the
-- housing result in its existing columns, with every bet's result in `bets`.
-- Additive only: existing rows default to 'housing'.

alter table public.cycle_claims add column if not exists bet_id text not null default 'housing';
alter table public.cycle_weight_moves add column if not exists bet_id text not null default 'housing';
alter table public.cycle_tripwire_events add column if not exists bet_id text;
alter table public.cycle_checkpoints add column if not exists bets jsonb;

create index if not exists cycle_weight_moves_bet_date_idx on public.cycle_weight_moves (bet_id, date desc);

comment on column public.cycle_claims.bet_id is 'housing | spx (thesis v1.2 bets). C1-C3, C30, C34-C36 = spx.';
comment on column public.cycle_weight_moves.bet_id is 'Which bet''s odds moved: housing | spx.';
comment on column public.cycle_tripwire_events.bet_id is 'The bet a tripwire speaks to (spx_drawdown_10 = spx); null = housing / shared.';
comment on column public.cycle_checkpoints.bets is 'Per-bet result of this review: {bet_id: {weights_before, weights_after, moved, argument, opposite_case, reverses_if, proposal_source, votes, claims_resolved}}. Housing is also in the legacy columns.';

-- RLS is already enabled on every cycle_* table (2026-11-01 / 2026-11-02 migrations);
-- re-asserted so the security advisor never sees a gap.
alter table public.cycle_claims enable row level security;
alter table public.cycle_weight_moves enable row level security;
alter table public.cycle_tripwire_events enable row level security;
alter table public.cycle_checkpoints enable row level security;
