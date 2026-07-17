-- Master DNC suppression list (email drip campaign brief, 2026-07-17).
-- One table unifying every "do not contact" signal across systems.
-- Match rule: a contact is suppressed for a given send when email OR phone
-- matches AND (channel = 'all' OR channel matches the send's channel).
--
-- Backfill sources:
--   1. leads.is_dnc            → channel 'all'  (people who asked to stop)
--   2. dnc_list                → channel 'all'  (Phase 7C vendor-export list)
--   3. relationships do_not_contact → DELIBERATELY NOT BACKFILLED.
--      Verified 2026-07-17: all 607 rows are cleanup_verdict='never'
--      rotation removals (Ryan's one-sided triage), not opt-out requests —
--      and Ryan's locked decision is that Relationships status never blocks
--      the campaign drip. Genuine opt-outs on that side (none found) get
--      added individually via the ad-hoc add path.
--
-- Spreadsheet-derived opt-outs (prior Brevo unsubscribes + call-note
-- opt-outs) are inserted by scripts/import-agent-campaign.mjs, which owns
-- everything sourced from the raw agent xlsx.
--
-- Phone convention: last-10 digits, no formatting (matches leads.caller_phone).
-- Email convention: lowercased, trimmed.

create table if not exists suppression (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  name text,
  parcel_number text,
  site_address text,
  site_city text,
  site_state text,
  site_zip text,
  mail_address text,
  mail_city text,
  mail_state text,
  mail_zip text,
  county text,
  reason text,
  source text not null,
  source_ref text,
  channel text not null default 'all'
    check (channel in ('mail', 'email', 'sms', 'call', 'all')),
  audience text not null default 'unknown',
  created_at timestamptz not null default now()
);

create index if not exists suppression_email_idx on suppression (lower(email));
create index if not exists suppression_phone_idx on suppression (phone);
-- Idempotency anchor for backfills/imports: one row per (source, source_ref).
create unique index if not exists suppression_source_ref_uniq
  on suppression (source, source_ref) where source_ref is not null;

-- Backfill 1: leads flagged DNC. One suppression row per flagged lead row
-- (clusters can flag several rows; duplicates by person are harmless — the
-- match is by email/phone, and per-row source_ref keeps this idempotent).
insert into suppression
  (email, phone, name, site_address, reason, source, source_ref, channel, audience, created_at)
select
  lower(nullif(trim(l.email), '')),
  nullif(right(regexp_replace(coalesce(l.caller_phone, ''), '\D', '', 'g'), 10), ''),
  l.name,
  l.property_address,
  'lead marked DNC in Mission Control',
  'lead_dnc',
  l.id::text,
  'all',
  'seller',
  l.created_at
from leads l
where l.is_dnc = true
on conflict (source, source_ref) where source_ref is not null do nothing;

-- Backfill 2: dnc_list (address-shaped vendor-export rows). Pull email/phone
-- from the source lead when linked so these rows match on identity too.
insert into suppression
  (email, phone, name, parcel_number, site_address, site_city, site_state, site_zip,
   mail_address, mail_city, mail_state, mail_zip, county, reason, source, source_ref,
   channel, audience, created_at)
select
  lower(nullif(trim(l.email), '')),
  nullif(right(regexp_replace(coalesce(l.caller_phone, ''), '\D', '', 'g'), 10), ''),
  coalesce(d.owner_name, l.name),
  d.parcel_number, d.site_address, d.site_city, d.site_state, d.site_zip,
  d.mail_address, d.mail_city, d.mail_state, d.mail_zip, d.county,
  coalesce(d.reason, 'dnc_list entry'),
  'dnc_list',
  d.id::text,
  'all',
  'seller',
  coalesce(d.added_at, now())
from dnc_list d
left join leads l on l.id = d.source_lead_id
on conflict (source, source_ref) where source_ref is not null do nothing;
