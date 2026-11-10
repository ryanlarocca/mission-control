-- Projects page (Mission Control 2.0 shell, Part D, 2026-11-10): one row per
-- project memo (~/Projects/PROJECTS/<slug>/PROJECT_MEMO.md + CHANGELOG.md, and
-- retired ones under _archive/). Written only by scripts/projects-sync.mjs on
-- the Mac mini (service role: upsert by slug, delete rows whose memo is gone);
-- read by GET /api/projects. RLS on, no policies.
--   status     active | planning | parked | retired
--   left_off   the "📍 Where we left off" section, markdown, ≤ 6,000 chars
--   ships      newest first, up to 8: [{ "date": "YYYY-MM-DD", "title": "…" }]
create table if not exists project_memos (
  slug text primary key,
  name text not null,
  status text not null,
  status_line text,
  plain text,
  owns text,
  updated_on date,
  left_off text,
  ships jsonb not null default '[]'::jsonb,
  archived boolean not null default false,
  synced_at timestamptz not null default now()
);
alter table project_memos enable row level security;

do $$ begin
  alter table project_memos add constraint project_memos_status_check
    check (status in ('active', 'planning', 'parked', 'retired'));
exception when duplicate_object then null; end $$;

create index if not exists project_memos_updated_idx on project_memos (updated_on desc nulls last);
