-- Autopilot writer (2026-11-13): Opus edits each autopilot text to fit the
-- person's card, and may hold one (send nothing) — scripts/autopilot-writer.js.
-- Two more columns of autopilot state (scripts/autopilot.js):
--   autopilot_next_at  when set, the next autopilot text is due exactly then
--                      (set when someone is put back on autopilot: 30 days
--                      after the last contact). Cleared when a text sends or
--                      is held.
--   autopilot_holds    consecutive texts the writer chose not to send. Back to
--                      0 on a send; 2 in a row stops autopilot for the person.
alter table leads add column if not exists autopilot_next_at timestamptz;
alter table leads add column if not exists autopilot_holds smallint not null default 0;
