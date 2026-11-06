-- Mac mini outside watcher (2026-11-06). Every alert about the mini ran ON the
-- mini, so a mini that was off, frozen or offline could never say so.
--   ~/bin/mini-heartbeat.sh (launchd com.lrghomes.mini-heartbeat, every 60 s)
--     upserts row 'mini': beat_at = now, watchdog_at = last bridge-watchdog tick.
--   pg_cron 'mini-watch' (below, every minute) calls /api/mini/watch on Vercel,
--     which alerts Telegram once when beats stop (and once when they resume),
--     and once if the watchdog stops ticking while the mini is alive.
--   info.quiet_until: set by `claude-remote-ctl.py reboot` so a reboot Ryan
--     asked for doesn't page him.
-- down_alerted_at / watchdog_alerted_at are the route's "already told him" marks.
create table if not exists mini_heartbeat (
  id text primary key,
  beat_at timestamptz not null default now(),
  watchdog_at timestamptz,
  info jsonb not null default '{}'::jsonb,
  down_alerted_at timestamptz,
  watchdog_alerted_at timestamptz
);
alter table mini_heartbeat enable row level security;

create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.schedule(
  'mini-watch',
  '* * * * *',
  $$ select net.http_get(url := 'https://mission-control-three-chi.vercel.app/api/mini/watch', timeout_milliseconds := 20000) $$
);
