-- A lead's best number (2026-11-10). A seller called from her daughter's
-- office and gave her own cell on the call; the card could only dial the
-- number she called from.
--
-- The card stays keyed on the number they first reached us from
-- (leads.caller_phone — every cluster, verdict and alert hangs off it). This
-- table adds ONE other number per person: the one to actually ring and text.
--
--   person_phone  the card (caller_phone of the cluster)
--   best_phone    the number they asked to be reached at — calls and texts
--                 go here; a call or text FROM it lands on the same card
--   source        judge (heard on a call / read in a text) | ryan (typed in)
--   heard         the judge's one-line note on where it came from
--
-- Read / written through lib/leadPhones.ts and scripts/judge.js.
-- Idempotent — safe to re-run.
create table if not exists lead_best_numbers (
  person_phone text primary key,
  best_phone text not null unique,
  source text not null default 'ryan',
  heard text,
  created_at timestamptz not null default now()
);
alter table lead_best_numbers enable row level security;
