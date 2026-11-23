-- Website video events (lrghomes.com). Written to by api/video-event.js with the service key.
create table if not exists public.site_video_events (
  id          bigint generated always as identity primary key,
  video_id    text not null,
  event       text not null,
  quartile    int,
  played      boolean,
  path        text,
  referrer    text,
  viewport_w  int,
  session_id  text,
  user_agent  text,
  country     text,
  created_at  timestamptz not null default now()
);

create index if not exists site_video_events_video_created_idx
  on public.site_video_events (video_id, created_at);

alter table public.site_video_events enable row level security;
-- No policies on purpose: only the service role (the website function) can read or write.

-- 2026-11-23: free-text diagnostics for blocked/error plays (error message, network/ready state, chosen file)
alter table public.site_video_events add column if not exists detail text;
