-- Mac mini low-space alert (2026-11-09). The mini's drive is 256 GB and hit
-- 94% full with nothing warning anyone. ~/bin/mini-heartbeat.sh now also
-- reports free disk (df -k /System/Volumes/Data, "Available"); /api/mini/watch
-- alerts once per level change: warn below 25 GB (clears above 30), urgent
-- below 10 GB (clears above 15). space_level is the route's "already told
-- him" mark. Table already has RLS (2026-11-06). Idempotent.
alter table mini_heartbeat add column if not exists free_kb bigint;
alter table mini_heartbeat add column if not exists space_level text;
comment on column mini_heartbeat.free_kb is 'Free disk on the mini (KB, df Available), from mini-heartbeat.sh.';
comment on column mini_heartbeat.space_level is 'Last low-space level alerted: null | warn | urgent (route-owned).';
