-- Jackie coin-flip test on the NOO Q4 mailer lines (Ryan approved 2026-10-27).
--
-- call_arm  — set on the intake row of a call to a NOO Q4 line while the flip
--             is on (inbox_settings key jackie_flip):
--               answered  = first-time caller, Ryan picked up in the 12 s ring
--               voicemail = first-time caller, coin flip → Ryan's voicemail
--               jackie    = first-time caller, coin flip → Jackie
--               returning = known number (any prior lead row, Relationships
--                           card, or iPhone call) → voicemail, not in the test
--             Null = before the test, or the flip was off.
-- jackie_call — what happened on her leg: session id, duration, whether she
--             finished the intake, the callback she promised, failures.
-- call_duration_sec — talk time of a live call (Ryan answered an inbound call,
--             or his click-to-call connected). The scoreboard's "made contact
--             within 7 days" reads it.
--
-- Applied from the Mac mini: node scripts/run-migration.mjs supabase/migrations/2026-10-27_jackie_call_arm.sql
alter table public.leads add column if not exists call_arm text;
alter table public.leads add column if not exists jackie_call jsonb;
alter table public.leads add column if not exists call_duration_sec integer;

do $$ begin
  alter table public.leads add constraint leads_call_arm_check
    check (call_arm is null or call_arm in ('answered', 'voicemail', 'jackie', 'returning'));
exception when duplicate_object then null; end $$;

create index if not exists leads_call_arm_idx on public.leads (call_arm, created_at) where call_arm is not null;
