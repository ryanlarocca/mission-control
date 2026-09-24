-- Reply Planner (briefs/BRIEF_REPLY_PLANNER_2026-09-24.md), Phase 1.
-- One table for every AI-drafted reply on every surface: what was proposed,
-- what Ryan said was wrong ("why"), and what actually went out.
create table if not exists reply_drafts (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  surface          text not null,            -- leads_card | followups | relationships | drip | telegram | eval
  lead_id          uuid,
  relationship_id  uuid,
  drip_queue_id    uuid,
  channel          text,                     -- email | sms | imessage
  moment           text,
  temperature      text,
  next_action      text,
  plan_json        jsonb,
  draft_subject    text,
  draft_body       text,
  model            text,
  prompt_version   text,
  playbook_version text,
  why_text         text,                     -- Ryan's one-sentence "what's off" that produced this redraft
  parent_draft_id  uuid references reply_drafts(id),
  critic_json      jsonb,                    -- what the critic pass changed, if anything
  sent_subject     text,
  sent_body        text,
  sent_at          timestamptz,
  was_edited       boolean
);
create index if not exists reply_drafts_lead_idx on reply_drafts (lead_id) where lead_id is not null;
create index if not exists reply_drafts_relationship_idx on reply_drafts (relationship_id) where relationship_id is not null;
create index if not exists reply_drafts_moment_sent_idx on reply_drafts (moment, sent_at) where sent_at is not null;
create index if not exists reply_drafts_why_idx on reply_drafts (created_at) where why_text is not null;

-- The plan's first chip lives on the lead so worklists and the drip engine
-- can read it without joining drafts.
alter table leads add column if not exists moment    text;
alter table leads add column if not exists moment_at timestamptz;
