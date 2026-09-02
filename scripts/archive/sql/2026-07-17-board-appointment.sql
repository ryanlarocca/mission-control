-- The Board: add 'appointment' rep type (weekly goal: 2 booked appointments).
-- Widens the board_events event_type check. Idempotent — safe to re-run.

alter table public.board_events drop constraint if exists board_events_event_type_check;
alter table public.board_events add constraint board_events_event_type_check
  check (event_type in
    ('contact_touch','offer','draft','dg_round','dg_practice','cage','softball_game','appointment'));
