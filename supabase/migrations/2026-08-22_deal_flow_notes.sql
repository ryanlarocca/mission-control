-- Deal Flow analysis — per-property comments (LRG CRMS project).
-- The analysis data itself ships as a static JSON snapshot in the repo
-- (data/deal-flow.json, regenerated from ~/Projects/PROJECTS/deal-analysis);
-- only Ryan's comments live in the DB. Server-side access via
-- getLeadsClient() (service role); RLS enabled with no policies.
create table if not exists public.deal_flow_notes (
  id         uuid primary key default gen_random_uuid(),
  address    text not null,          -- CLEAN_ALL.csv Address, verbatim
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists deal_flow_notes_address_idx on public.deal_flow_notes (address, created_at);
alter table public.deal_flow_notes enable row level security;
