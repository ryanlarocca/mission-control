-- AI spend ledger (2026-11-07 API cost audit). One row per Anthropic call,
-- written by lib/llmUsage.ts (Vercel) and scripts/llm-usage.cjs (Mac mini).
--   lane: which Console key paid — 'drafts' (reply drafts, coach, call
--         scripts, CRMS composer) or 'background' (everything else).
--   tag:  the feature, e.g. '[reply/auto]', '[judge]', '[inbox-agent]'.
--   cost_usd: priced from config/llm-prices.json at write time.
--   error_kind: 'billing' = refused for money (credit / spend limit) — the
--         6-hour Telegram alert dedupes on it; 'error' = anything else.
-- scripts/llm-spend-report.mjs reads llm_usage_rollup() for the Telegram
-- daily / weekly line and the over-$4-a-day alert.
create table if not exists llm_usage (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  lane text not null,
  model text not null,
  tag text,
  source text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  ok boolean not null default true,
  error_kind text,
  error text
);
create index if not exists llm_usage_created_at_idx on llm_usage (created_at desc);
create index if not exists llm_usage_billing_idx on llm_usage (lane, created_at desc) where error_kind = 'billing';
alter table llm_usage enable row level security;

-- Totals per lane + feature + model for a window (no PostgREST row cap).
create or replace function llm_usage_rollup(p_from timestamptz, p_to timestamptz)
returns table (
  lane text,
  tag text,
  model text,
  calls bigint,
  failures bigint,
  cost_usd numeric,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select lane, coalesce(tag, '[llm]'), model,
         count(*), count(*) filter (where not ok),
         coalesce(sum(cost_usd), 0),
         coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0),
         coalesce(sum(cache_read_tokens), 0), coalesce(sum(cache_write_tokens), 0)
  from llm_usage
  where created_at >= p_from and created_at < p_to
  group by 1, 2, 3
$$;
revoke execute on function llm_usage_rollup(timestamptz, timestamptz) from public, anon, authenticated;
