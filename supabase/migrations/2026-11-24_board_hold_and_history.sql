-- The Board v2 (2026-11-24): on hold, notes path, who updated, and a history
-- log per card. Ryan: cards "just kind of sit at the top… almost like a to-do
-- list"; on-hold projects looked like they needed him.
--   on_hold     true = nothing needed from Ryan until due_date; the card sits
--               in the folded "On hold" group and comes back into its lane by
--               itself on that date (display rule, nothing scheduled).
--   notes_path  where the project's notes live, relative to ~/Projects/PROJECTS
--               ("deals/261-bieber-dr.md") or "memory/<file>.md" for agent
--               memory; comma-separated for more than one. wrap-check flags a
--               card whose notes moved after its last update.
--   updated_by  "Ryan" (board page) or "Claude" (scripts/board.mjs); copied
--               into the log.
-- board_item_log is written ONLY by the trigger below (every writer logs,
-- whatever path it takes) plus "checked, no change" rows from board.mjs touch.
-- RLS on, no policies (service-role server routes only).
alter table board_items add column if not exists on_hold boolean not null default false;
alter table board_items add column if not exists notes_path text;
alter table board_items add column if not exists updated_by text;

create table if not exists board_item_log (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references board_items (id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null default 'update', -- created | update | done | reopened | checked
  by_who text,
  title text,
  next_step text,
  lane text,
  waiting_on text,
  due_date date,
  on_hold boolean,
  note text
);
alter table board_item_log enable row level security;
create index if not exists board_item_log_item_idx on board_item_log (item_id, at desc);

create or replace function public.board_items_log_change() returns trigger
language plpgsql
set search_path = ''
as $$
declare k text;
begin
  if tg_op = 'INSERT' then
    k := 'created';
  elsif new.status is distinct from old.status then
    k := case when new.status = 'done' then 'done' else 'reopened' end;
  elsif new.next_step is distinct from old.next_step
     or new.lane is distinct from old.lane
     or new.waiting_on is distinct from old.waiting_on
     or new.due_date is distinct from old.due_date
     or new.on_hold is distinct from old.on_hold
     or new.title is distinct from old.title then
    k := 'update';
  else
    return new;
  end if;
  insert into public.board_item_log (item_id, kind, by_who, title, next_step, lane, waiting_on, due_date, on_hold)
  values (new.id, k, new.updated_by, new.title, new.next_step, new.lane, new.waiting_on, new.due_date, new.on_hold);
  return new;
end $$;

drop trigger if exists board_items_log on board_items;
create trigger board_items_log after insert or update on board_items
  for each row execute function public.board_items_log_change();

-- Seed: one row per existing card with its current state, dated its last update.
insert into board_item_log (item_id, at, kind, by_who, title, next_step, lane, waiting_on, due_date, on_hold, note)
select b.id, b.updated_at, 'update', null, b.title, b.next_step, b.lane, b.waiting_on, b.due_date, b.on_hold, 'Status before history started'
from board_items b
where not exists (select 1 from board_item_log l where l.item_id = b.id);
