-- Campaign autopilot gates (briefs/BRIEF_CAMPAIGN_AUTOPILOT_GATES_2026-10-14.md).
-- Idempotent — safe to re-run. Apply from the Mac mini:
--   node scripts/run-migration.mjs supabase/migrations/2026-10-15_campaign_autopilot_gates.sql
--
-- Task 1 — auto-approve lives in campaign_settings, not env. Seeded with
-- touches [1] pinned to the live compose prompt (PROMPT_VERSION in
-- scripts/campaign-compose.mjs). If the engine sees a different
-- PROMPT_VERSION it re-gates T1 and waits for "auto T1 on".
insert into campaign_settings (key, value, updated_at)
values (
  'auto_send_touches',
  jsonb_build_object(
    'touches', jsonb_build_array(1),
    'pinned_prompt_version', 'v5-2026-10-02',
    'engine_prompt_version', 'v5-2026-10-02',
    'changed_by', 'migration',
    'changed_at', now(),
    'reason', 'seed: T1 unattended (Ryan 2026-10-14)'
  ),
  now()
)
on conflict (key) do nothing;

-- Task 5 — email-verification columns on campaign_contacts (vendor-neutral;
-- the verifier behind lib/verify.ts is MillionVerifier as of 2026-10-15).
alter table campaign_contacts add column if not exists verified_at timestamptz;
comment on column campaign_contacts.verified_at is 'When the verifier last checked this address (lib/verify.ts). Null = never; draft-eligible only when within 30 days once verify_required is on';
alter table campaign_contacts add column if not exists verify_result text;
comment on column campaign_contacts.verify_result is 'verifier result: deliverable | undeliverable | risky | unknown';
alter table campaign_contacts add column if not exists verify_reason text;
comment on column campaign_contacts.verify_reason is 'verifier reason / sub-result (ok, disposable, timeout, api_error:…, …)';
alter table campaign_contacts add column if not exists verify_accept_all boolean;
comment on column campaign_contacts.verify_accept_all is 'verify_accept_all: the DOMAIN is catch-all. Never a filter — counted on the daily card as "catch-all"';

create index if not exists campaign_contacts_verify_idx
  on campaign_contacts (verified_at) where status = 'active';

-- Task 5 — a verifier "undeliverable" verdict parks the contact as 'invalid'
-- (NOT 'bounced', so the July bounce wave stays distinguishable). The
-- original inline check constraint is rebuilt with the new value.
alter table campaign_contacts drop constraint if exists campaign_contacts_status_check;
alter table campaign_contacts add constraint campaign_contacts_status_check
  check (status in ('active', 'paused', 'replied', 'bounced', 'unsubscribed',
                    'suppressed', 'bad_email', 'no_email', 'invalid'));

-- RLS is already on for campaign_contacts (service-role access only); this is
-- an idempotent no-op kept so the table never silently regresses.
alter table campaign_contacts enable row level security;

-- Task 5 — the verify rule is OFF until Ryan says "verify rule on" after the
-- first --verify-all pass (the bridge session flips enabled to true).
insert into campaign_settings (key, value, updated_at)
values ('verify_required', jsonb_build_object('enabled', false, 'changed_by', 'migration', 'changed_at', now()), now())
on conflict (key) do nothing;
