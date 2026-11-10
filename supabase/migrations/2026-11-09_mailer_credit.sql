-- Mailer credit — "the last campaign they were part of" (Ryan 2026-11-09,
-- briefs/BRIEF_MAILER_CREDIT_RULE_2026-11-09.md). Columns only on existing
-- tables (RLS already on both); the two SQL functions change how a mailed
-- record counts as answered. Idempotent — safe to re-run.

-- How a row got its campaign: line (dialed the letter's number / emailed its
-- alias), inherited (carried from the person's earlier rows), match (matched
-- to the mailed list — lib/mailCredit), manual (Ryan's pick, or a hand-
-- attached legacy close).
alter table public.leads add column if not exists campaign_via text;
comment on column public.leads.campaign_via is 'How campaign_id was set: line | inherited | match | manual (lib/mailCredit).';

-- The day a mailing's first batch went out. A list's campaign takes match
-- credit from this day (D1); null = not mailed yet.
alter table public.campaigns add column if not exists first_drop_date date;
comment on column public.campaigns.first_drop_date is 'First batch mailed (ITI). Mailed-list credit starts this day; null = not started.';

-- NOO Q4 2026: drop 1 mailed 2026-10-27 (ITI order #243496 status mail +
-- Juan 2026-10-22: 10/27, 11/3, 11/10, 11/17).
update public.campaigns set first_drop_date = '2026-10-27'
where source_label = 'NOO-Q4-2026' and parent_campaign_id is null and first_drop_date is null;

-- Backfill campaign_via on rows that already carry a campaign.
--   letter line: the row's line is that campaign's own number
--   alias: an email: row on a campaign with a source_label
--   outbound / callback / other inbound with a campaign: inherited
--   the two hand-attached legacy closes (campaigns.legacy): manual
update public.leads l set campaign_via = 'manual'
from public.campaigns c
where l.campaign_id = c.id and l.campaign_via is null and coalesce(c.legacy, false);

update public.leads set campaign_via = 'line'
where campaign_via is null and campaign_id is not null and (
  (twilio_number in ('+14084186294') and source = 'NOO-Q4-2026-A') or
  (twilio_number in ('+14084188450') and source = 'NOO-Q4-2026-B') or
  (twilio_number = '+16504364279' and source = 'MFM-A') or
  (twilio_number = '+16506803671' and source = 'MFM-B') or
  (twilio_number like 'email:%' and source is not null and source <> 'Legacy DM')
);

update public.leads set campaign_via = 'match'
where campaign_via is null and campaign_id is not null and lead_type = 'form' and source_type = 'website';

update public.leads set campaign_via = 'inherited'
where campaign_via is null and campaign_id is not null;

-- ── Segment funnel: a mailed record counts as answered only by a CREDITED
-- inbound contact on/after the mailing's first drop (a link alone — e.g. from
-- Ryan's outbound call, or a card edit — no longer makes a "responder").
-- Milestones / removals count when they happened on/after that day.
create or replace function mail_segment_funnel(p_campaign uuid, p_piece text default null)
returns table(
  dimension text, segment text, pieces bigint,
  responses bigint, removals bigint, real_responses bigint, leads bigint,
  appointments bigint, offers bigint, pending bigint, closed bigint
)
language sql stable as $$
  with fam as (
    select id from campaigns where id = p_campaign or parent_campaign_id = p_campaign
  ),
  start as (
    select first_drop_date as d from campaigns where id = p_campaign
  ),
  -- the people (by record) who answered: a credited inbound row on/after the start
  answered as (
    select distinct l.mail_record_id
    from leads l, start
    where l.mail_record_id is not null
      and l.campaign_id in (select id from fam)
      and (l.twilio_number is not null or l.lead_type = 'form')
      and start.d is not null
      and (l.created_at at time zone 'America/Los_Angeles')::date >= start.d
  ),
  lr as (
    select l.mail_record_id,
      bool_or(coalesce(l.is_dnc, false)) as r_dnc,
      bool_or(not coalesce(l.is_junk, false) and l.campaign_id in (select id from fam)) as r_nonjunk,
      bool_or(l.became_lead_at is not null and (l.became_lead_at at time zone 'America/Los_Angeles')::date >= (select d from start)) as r_lead,
      bool_or(l.appointment_at is not null and (l.created_at at time zone 'America/Los_Angeles')::date >= (select d from start)) as r_appt,
      bool_or(l.offer_verbalized_at is not null and (l.offer_verbalized_at at time zone 'America/Los_Angeles')::date >= (select d from start)) as r_offer,
      bool_or(l.pending_at is not null and (l.pending_at at time zone 'America/Los_Angeles')::date >= (select d from start)) as r_pending,
      bool_or(l.deal_closed_at is not null and (l.deal_closed_at at time zone 'America/Los_Angeles')::date >= (select d from start)) as r_closed
    from leads l
    where l.mail_record_id in (select mail_record_id from answered)
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

-- ── Response timing: first contact = the earliest CREDITED, non-junk inbound
-- row on/after the mailing's first drop (was: the earliest linked row of any
-- kind, which dated old leads from their first-ever call).
CREATE OR REPLACE FUNCTION mail_response_timing(p_campaign uuid)
RETURNS TABLE(batch int, pieces bigint, responders bigint, median_days numeric, p25_days numeric, p75_days numeric, weekly jsonb)
LANGUAGE sql STABLE AS $$
  WITH fam AS (
    SELECT id FROM campaigns WHERE id = p_campaign OR parent_campaign_id = p_campaign
  ),
  start AS (
    SELECT first_drop_date AS d FROM campaigns WHERE id = p_campaign
  ),
  mailed AS (
    SELECT m.batch,
           coalesce(m.arrived_at, m.drop_date) AS arrived,
           (SELECT min(l.created_at) FROM leads l
             WHERE l.mail_record_id = m.id AND coalesce(l.is_junk, false) = false
               AND l.campaign_id IN (SELECT id FROM fam)
               AND (l.twilio_number IS NOT NULL OR l.lead_type = 'form')
               AND (l.created_at AT TIME ZONE 'America/Los_Angeles')::date >= (SELECT d FROM start)) AS first_inbound
    FROM mail_records m
    WHERE m.campaign_id = p_campaign AND m.is_seed = false AND m.arm IN ('A', 'B', 'C')
  ),
  timed AS (
    SELECT batch, first_inbound,
           CASE WHEN arrived IS NOT NULL AND first_inbound IS NOT NULL
                THEN (first_inbound AT TIME ZONE 'America/Los_Angeles')::date - arrived
           END AS days
    FROM mailed
  ),
  weeks AS (
    SELECT batch, floor(days / 7.0)::int AS week, count(*) AS n
    FROM timed WHERE days IS NOT NULL GROUP BY 1, 2
  ),
  weekly AS (
    SELECT batch, jsonb_object_agg(week::text, n ORDER BY week) AS weekly FROM weeks GROUP BY 1
  ),
  stats AS (
    SELECT batch,
           count(*) AS pieces,
           count(*) FILTER (WHERE first_inbound IS NOT NULL) AS responders,
           round((percentile_cont(0.5)  WITHIN GROUP (ORDER BY days))::numeric, 1) AS median_days,
           round((percentile_cont(0.25) WITHIN GROUP (ORDER BY days))::numeric, 1) AS p25_days,
           round((percentile_cont(0.75) WITHIN GROUP (ORDER BY days))::numeric, 1) AS p75_days
    FROM timed GROUP BY 1
  )
  SELECT s.batch, s.pieces, s.responders, s.median_days, s.p25_days, s.p75_days,
         coalesce(w.weekly, '{}'::jsonb) AS weekly
  FROM stats s
  LEFT JOIN weekly w ON w.batch IS NOT DISTINCT FROM s.batch
  ORDER BY s.batch NULLS LAST;
$$;

-- Same, one creative (A/B piece children). Keep in lockstep with the above;
-- the only difference is `AND m.piece = p_piece`.
CREATE OR REPLACE FUNCTION mail_response_timing_piece(p_campaign uuid, p_piece text)
RETURNS TABLE(batch int, pieces bigint, responders bigint, median_days numeric, p25_days numeric, p75_days numeric, weekly jsonb)
LANGUAGE sql STABLE AS $$
  WITH fam AS (
    SELECT id FROM campaigns WHERE id = p_campaign OR parent_campaign_id = p_campaign
  ),
  start AS (
    SELECT first_drop_date AS d FROM campaigns WHERE id = p_campaign
  ),
  mailed AS (
    SELECT m.batch,
           coalesce(m.arrived_at, m.drop_date) AS arrived,
           (SELECT min(l.created_at) FROM leads l
             WHERE l.mail_record_id = m.id AND coalesce(l.is_junk, false) = false
               AND l.campaign_id IN (SELECT id FROM fam)
               AND (l.twilio_number IS NOT NULL OR l.lead_type = 'form')
               AND (l.created_at AT TIME ZONE 'America/Los_Angeles')::date >= (SELECT d FROM start)) AS first_inbound
    FROM mail_records m
    WHERE m.campaign_id = p_campaign AND m.is_seed = false AND m.arm IN ('A', 'B', 'C')
      AND m.piece = p_piece
  ),
  timed AS (
    SELECT batch, first_inbound,
           CASE WHEN arrived IS NOT NULL AND first_inbound IS NOT NULL
                THEN (first_inbound AT TIME ZONE 'America/Los_Angeles')::date - arrived
           END AS days
    FROM mailed
  ),
  weeks AS (
    SELECT batch, floor(days / 7.0)::int AS week, count(*) AS n
    FROM timed WHERE days IS NOT NULL GROUP BY 1, 2
  ),
  weekly AS (
    SELECT batch, jsonb_object_agg(week::text, n ORDER BY week) AS weekly FROM weeks GROUP BY 1
  ),
  stats AS (
    SELECT batch,
           count(*) AS pieces,
           count(*) FILTER (WHERE first_inbound IS NOT NULL) AS responders,
           round((percentile_cont(0.5)  WITHIN GROUP (ORDER BY days))::numeric, 1) AS median_days,
           round((percentile_cont(0.25) WITHIN GROUP (ORDER BY days))::numeric, 1) AS p25_days,
           round((percentile_cont(0.75) WITHIN GROUP (ORDER BY days))::numeric, 1) AS p75_days
    FROM timed GROUP BY 1
  )
  SELECT s.batch, s.pieces, s.responders, s.median_days, s.p25_days, s.p75_days,
         coalesce(w.weekly, '{}'::jsonb) AS weekly
  FROM stats s
  LEFT JOIN weekly w ON w.batch IS NOT DISTINCT FROM s.batch
  ORDER BY s.batch NULLS LAST;
$$;
