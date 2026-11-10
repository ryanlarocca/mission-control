-- The Hopper (Mission Control 2.0 shell, 2026-11-10): Ryan's list of tools
-- and ideas that aren't on day one. Read and added to from /hopper; written
-- only by app/api/hopper (service role). RLS on, no policies.
--   kind    tool | idea
--   status  open | picked_up | dropped   (dropped hides; picked_up folds away)
create table if not exists hopper_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  note text,
  kind text not null default 'idea',
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table hopper_items enable row level security;

do $$ begin
  alter table hopper_items add constraint hopper_items_kind_check check (kind in ('tool', 'idea'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table hopper_items add constraint hopper_items_status_check check (status in ('open', 'picked_up', 'dropped'));
exception when duplicate_object then null; end $$;

create unique index if not exists hopper_items_title_key on hopper_items (lower(title));
create index if not exists hopper_items_list_idx on hopper_items (status, created_at desc);

-- Seed. Re-running is harmless: a title already on the list is skipped.
-- Timestamps step back a second per row so "newest first" keeps this order.
insert into hopper_items (title, note, kind, created_at, updated_at)
select s.title, s.note, s.kind, now() - (s.ord * interval '1 second'), now() - (s.ord * interval '1 second')
from (values
  (1,  'tool', 'Property Lookup', 'One address box: owner of record, sales chain, skip trace, mail history, comps, existing lead/relationship record'),
  (2,  'tool', 'Underwrite', 'Deal + loan calculator: purchase, rehab, ARV, loan terms → profit vs the $200k gate'),
  (3,  'tool', 'Sign', 'A screen for the e-sign service'),
  (4,  'tool', 'Offers', 'A screen for the offer bot'),
  (5,  'tool', 'Video Editor', 'Footage, drafts, covers, post results'),
  (6,  'idea', 'Deal Flow revamp', 'Every property ever pitched and what happened to it'),
  (7,  'idea', 'Past Deals folder', 'Underwriting vs actual, each becomes a comp'),
  (8,  'idea', 'Health v2', 'Per-job last success, plain-English error log, helper freeze watchdog'),
  (9,  'idea', 'Texts search with an AI layer', null),
  (10, 'idea', 'Jackie controls screen', null),
  (11, 'idea', 'Loans ledger / money dates on Today', null),
  (12, 'idea', 'Desktop calendar page', null),
  (13, 'idea', 'Business card generator', null),
  (14, 'idea', 'DNC scrub as a paste-a-list tool', null),
  (15, 'idea', 'Adobe replacement', null),
  (16, 'idea', 'Death-of-a-joint-tenant mail package', null),
  (17, 'idea', 'Networking bot: search Meetup / Eventbrite', null),
  (18, 'idea', 'Jackie as full-time receptionist', null),
  (19, 'idea', '"My Cell" flag on leads', null),
  (20, 'idea', 'Auto-clear video scratch files at wrap', null),
  (21, 'idea', 'The Board', 'Retired 2026-11-10; revive if wanted'),
  (22, 'idea', 'Referral business outreach', '24-source scraper concept'),
  (23, 'idea', 'Contact detail page for Relationships', null),
  (24, 'idea', 'Database farming ideas', null),
  (25, 'idea', 'Leads list: slim download', 'Load the full record when a card opens'),
  (26, 'idea', '"New version — tap to reload" banner', null)
) as s(ord, kind, title, note)
on conflict ((lower(title))) do nothing;
