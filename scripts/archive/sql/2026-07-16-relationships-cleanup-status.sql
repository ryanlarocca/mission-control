-- Relationships cleanup — status + triage-verdict columns.
-- status drives queue inclusion: 'do_not_contact' rows never surface in the
-- daily queue (unlike tier E, the contact keeps its tier and stays findable
-- in search). cleanup_verdict + cleanup_reviewed_at record the Cleanup-mode
-- triage pass (keep / vague / never) so progress survives across sessions.
-- Idempotent — safe to re-run.

alter table relationships
  add column if not exists status text not null default 'active';
alter table relationships
  add column if not exists cleanup_verdict text;
alter table relationships
  add column if not exists cleanup_reviewed_at timestamptz;

alter table relationships drop constraint if exists relationships_status_check;
alter table relationships add constraint relationships_status_check
  check (status in ('active','do_not_contact'));

alter table relationships drop constraint if exists relationships_cleanup_verdict_check;
alter table relationships add constraint relationships_cleanup_verdict_check
  check (cleanup_verdict is null or cleanup_verdict in ('keep','vague','never'));
