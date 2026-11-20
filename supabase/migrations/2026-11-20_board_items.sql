-- The Board (2026-11-20): one card per open thread in Ryan's life and work,
-- in four lanes (Your move · Waiting on someone · I'm handling · Done this
-- week). Replaces the retired 90-day goals board at /board (its
-- board_periods / board_events tables are left untouched).
-- Written only by app/api/board (service role) and scripts/board.mjs.
-- RLS on, no policies.
--   lane    you | waiting | me
--   status  open | done     (done shows for 7 days under "Done this week")
--   key     stable slug a chat uses to find and update its card
create table if not exists board_items (
  id uuid primary key default gen_random_uuid(),
  key text,
  title text not null,
  next_step text,
  lane text not null default 'you',
  waiting_on text,
  due_date date,
  due_note text,
  tag text,
  link text,
  status text not null default 'open',
  done_at timestamptz,
  sort_order integer not null default 0,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table board_items enable row level security;

do $$ begin
  alter table board_items add constraint board_items_lane_check check (lane in ('you', 'waiting', 'me'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table board_items add constraint board_items_status_check check (status in ('open', 'done'));
exception when duplicate_object then null; end $$;

-- Full (not partial) unique index so upserts can target it; NULL keys never collide.
create unique index if not exists board_items_key_key on board_items (key);
create index if not exists board_items_list_idx on board_items (status, lane, due_date);
create index if not exists board_items_done_idx on board_items (done_at desc) where status = 'done';
