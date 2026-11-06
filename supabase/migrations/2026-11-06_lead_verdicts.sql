-- The judge (2026-11-06, scripts/judge.js): one verdict per person about what
-- happens next, decided from the whole thread after it quiets down. Replaces
-- the per-event date writers (voicemail analyzer, text analyzer, owed rule,
-- Jackie, Send-executes-the-plan, …) that each wrote their own
-- recommended_followup_date and left the worklist showing the earliest one.
--
--   phone        the person (caller_phone of the cluster)
--   state        dnc | dead | appointment | call_on | waiting_on_them |
--                ryan_today | quiet_until | chase | none
--   due_date     the one date the worklist / card show (Pacific day)
--   reason       one plain-English line for the card
--   through_at   newest leads row the judge had read when it ruled — a row
--                created after this means the person is due for re-judging
--   source       judge | ryan — Ryan setting a date by hand is a verdict too,
--                and the judge honours it until something new happens
create table if not exists lead_verdicts (
  phone text primary key,
  state text not null,
  due_date date,
  reason text,
  through_at timestamptz not null,
  judged_at timestamptz not null default now(),
  source text not null default 'judge',
  model text,
  raw jsonb
);
alter table lead_verdicts enable row level security;
create index if not exists lead_verdicts_due_idx on lead_verdicts (state, due_date);
