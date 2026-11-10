-- Health page (Mission Control 2.0 shell, Part E, 2026-11-10): the Mac mini's
-- latest status snapshot, one row (id = 'mini'). Written every 5 minutes by
-- scripts/mini-status.mjs on the mini (launchd com.lrghomes.mini-status,
-- service role upsert); read by GET /api/health, so the Health page does not
-- depend on the mini's tunnel being up. RLS on, no policies.
--   snapshot   MiniSnapshot (lib/miniStatus.ts): jobs[], bridge, backup,
--              helper, textHistory, disk, uptime, errors[]
create table if not exists mini_status (
  id text primary key,
  reported_at timestamptz not null default now(),
  snapshot jsonb not null default '{}'::jsonb
);
alter table mini_status enable row level security;
