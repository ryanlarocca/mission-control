-- Lead funnel + automatic status (Ryan 2026-10-24, NOO Q4 2026 baseline tracking).
--
-- Funnel per campaign / segment:
--   Total responses → Real responses (minus DNC + junk) → Leads (ever Active)
--   → Appointment → Offer → Pending → Closed.
-- Offer already lives on leads (offer_amount / offer_verbalized_at) and
-- Closed on deal_closed_at / deal_value (2026-05-17); this adds the rest.
--
-- Milestone + became_lead_at columns are written CLUSTER-WIDE (every row on
-- the phone / email), like mail_record_id, so any row answers "how far did
-- this person get". Status itself stays on the card's status row.
--
-- lead_status_events is the status history (history starts 2026-10-24) and
-- the queue for the daily Telegram summary of automatic moves.

alter table leads add column if not exists appointment_at timestamptz;
alter table leads add column if not exists pending_at timestamptz;
alter table leads add column if not exists became_lead_at timestamptz;
alter table leads add column if not exists status_set_by text;
alter table leads add column if not exists status_set_at timestamptz;
comment on column leads.appointment_at is 'Funnel milestone: appointment date (Ryan taps it on the card). Cluster-wide.';
comment on column leads.pending_at is 'Funnel milestone: under contract date. Cluster-wide.';
comment on column leads.became_lead_at is 'First time this person was Active (a lead). Never cleared, so the funnel counts "ever a lead". Cluster-wide.';
comment on column leads.status_set_by is 'Who set the current status: ryan | auto | milestone. A status Ryan set wins over the automatic rules until something new happens.';
comment on column leads.status_set_at is 'When status_set_by last changed the status.';

create table if not exists lead_status_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  lead_id uuid not null references leads(id) on delete cascade,
  from_status text,
  to_status text not null,
  source text not null,              -- ryan | auto | milestone | undo
  rule text,                         -- auto: lead | not_now | quiet_30d | sold | wrong_person
  reason text,
  applied boolean not null default true,  -- false = shadow (auto-status switched off)
  digested_at timestamptz,
  undone_at timestamptz
);
create index if not exists lead_status_events_lead_idx on lead_status_events (lead_id, created_at desc);
create index if not exists lead_status_events_digest_idx on lead_status_events (created_at) where source = 'auto' and applied and digested_at is null;
alter table lead_status_events enable row level security;

-- Seed became_lead_at for people who are Active today or ever got an offer
-- / closed (best guess for the pre-history period; exact from 2026-10-24 on).
update leads l set became_lead_at = coalesce(l.offer_verbalized_at, l.deal_closed_at, l.created_at)
where l.became_lead_at is null
  and (l.status = 'active' or l.offer_verbalized_at is not null or l.deal_closed_at is not null);

-- Segment funnel. One row per (dimension, segment). piece = null → whole
-- parent list; piece = 'A' / 'B' → the A/B child's slice. Responder flags
-- read leads.mail_record_id, which is written cluster-wide.
create or replace function mail_segment_funnel(p_campaign uuid, p_piece text default null)
returns table(
  dimension text, segment text, pieces bigint,
  responses bigint, removals bigint, real_responses bigint, leads bigint,
  appointments bigint, offers bigint, pending bigint, closed bigint
)
language sql stable as $$
  -- Responder flags per mailed record, aggregated ONCE over leads (an
  -- EXISTS per flag per record timed out on the 16k-row NOO list).
  with lr as (
    select l.mail_record_id,
      bool_or(coalesce(l.is_dnc, false)) as r_dnc,
      bool_or(not coalesce(l.is_junk, false)) as r_nonjunk,
      bool_or(l.became_lead_at is not null) as r_lead,
      bool_or(l.appointment_at is not null) as r_appt,
      bool_or(l.offer_verbalized_at is not null) as r_offer,
      bool_or(l.pending_at is not null) as r_pending,
      bool_or(l.deal_closed_at is not null) as r_closed
    from leads l
    where l.mail_record_id is not null
    group by l.mail_record_id
  ),
  mailed as (
    select m.*,
      (lr.mail_record_id is not null) as r_any,
      coalesce(lr.r_dnc, false) as r_dnc,
      coalesce(lr.r_nonjunk, false) as r_nonjunk,
      coalesce(lr.r_lead, false) as r_lead,
      coalesce(lr.r_appt, false) as r_appt,
      coalesce(lr.r_offer, false) as r_offer,
      coalesce(lr.r_pending, false) as r_pending,
      coalesce(lr.r_closed, false) as r_closed
    from mail_records m
    left join lr on lr.mail_record_id = m.id
    where m.campaign_id = p_campaign and m.is_seed = false and m.arm in ('A', 'B', 'C')
      and (p_piece is null or m.piece = p_piece)
  ),
  dims as (
    select d.dimension, d.segment, m.r_any, m.r_dnc, m.r_nonjunk, m.r_lead, m.r_appt, m.r_offer, m.r_pending, m.r_closed
    from mailed m
    cross join lateral (values
      ('arm', m.arm),
      ('county', m.county),
      ('batch', m.batch::text),
      ('tenure_bucket', m.tenure_bucket),
      ('imp_tercile', m.imp_tercile),
      ('year_built_bucket', m.year_built_bucket),
      ('owner_type', m.owner_type),
      ('estate_language', case when m.estate_language then 'yes' else 'no' end),
      ('family_transfer', case when m.family_transfer then 'yes' else 'no' end),
      ('out_of_state', case when m.out_of_state then 'yes' else 'no' end),
      ('multi_parcel_personal', case when m.multi_parcel_personal then 'yes' else 'no' end),
      ('any_signal', case when m.any_signal then 'yes' else 'no' end),
      ('po_box', case when m.po_box then 'yes' else 'no' end),
      ('managed', case when m.managed then 'yes' else 'no' end),
      ('out_of_county', case when m.out_of_county then 'yes' else 'no' end),
      ('prior_mail', coalesce(m.prior_mail, 'fresh')),
      ('piece', coalesce(m.piece, 'unknown'))
    ) as d(dimension, segment)
  )
  select dimension, coalesce(segment, 'unknown') as segment,
    count(*) as pieces,
    count(*) filter (where r_any) as responses,
    count(*) filter (where r_dnc) as removals,
    count(*) filter (where r_nonjunk and not r_dnc) as real_responses,
    count(*) filter (where r_lead) as leads,
    count(*) filter (where r_appt) as appointments,
    count(*) filter (where r_offer) as offers,
    count(*) filter (where r_pending) as pending,
    count(*) filter (where r_closed) as closed
  from dims
  group by 1, 2
  order by 1, 2;
$$;
