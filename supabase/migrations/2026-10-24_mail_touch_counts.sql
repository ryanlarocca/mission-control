-- Direct-mail touch counts (Ryan 2026-10-24, research in
-- PROJECTS/lead-pipeline/research/2026-10-24_*). 22 drops since Nov 2021,
-- 21 with surviving address lists, matched on house number + street + zip.
--
-- leads.mail_pieces_before: letters this person had received up to and
-- including the one they answered (cluster-wide). Null = unknown (no
-- address, or no list match) — never read null as zero.
-- mail_records.prior_pieces: letters the NOO Q4 2026 owner had received
-- before this campaign, across ALL 20 earlier drops (the older prior_mail
-- flag only checked 2 of them).
alter table leads add column if not exists mail_pieces_before integer;
alter table leads add column if not exists mail_pieces_detail text[];
alter table mail_records add column if not exists prior_pieces integer;
comment on column leads.mail_pieces_before is 'Direct-mail pieces received up to and including the one answered; null = unknown. Cluster-wide.';
comment on column leads.mail_pieces_detail is 'Which drops, e.g. {"Nov 2023 SVEP flyer","Feb 2026 SVR SVA/SVB"}.';
comment on column mail_records.prior_pieces is 'Pieces this owner received from the 20 drops before this campaign (Nov 2021 → Apr 2026).';

-- Segment funnel gains the "letters before" dimension (0 / 1 / 2 / 3 / 4+).
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
      ('prior_pieces', case when m.prior_pieces is null then 'unknown' when m.prior_pieces >= 4 then '4+' else m.prior_pieces::text end),
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
