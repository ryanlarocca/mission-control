-- Direct-mail response timing (2026-10-12) — planned in
-- briefs/BRIEF_DM_ABSENTEE_Q4_2026_2026-10-08.md §3.4, built per
-- briefs/BRIEF_CLOUD_BATCH_2026-10-12.md Task 2.
--
-- How many days after a letter lands does the owner respond? Per batch:
--   pieces      mailed records (is_seed = false, arm in A/B/C)
--   responders  records with at least one non-junk lead linked to them
--   *_days      p25 / median / p75 of (first non-junk inbound date − arrival)
--   weekly      {"0": n, "1": n, …} responders by whole weeks since arrival
--               (0 = first 7 days; a negative key = lead logged before the
--               record's arrival date, which flags a bad drop_date/stamp)
-- arrival = coalesce(arrived_at, drop_date): the seed arrival stamp when one
-- has been written (scripts/stamp-arrived.mjs), else the campaign drop date.
-- A record with no arrival date, or no response, still counts in pieces /
-- responders but contributes nothing to the percentiles or the histogram —
-- so until arrived_at / drop_date are populated every *_days is null and
-- weekly is {}.
-- First inbound = earliest leads.created_at linked via mail_record_id, in
-- Pacific time (the business's calendar day).
-- Idempotent — safe to re-run.

CREATE OR REPLACE FUNCTION mail_response_timing(p_campaign uuid)
RETURNS TABLE(batch int, pieces bigint, responders bigint, median_days numeric, p25_days numeric, p75_days numeric, weekly jsonb)
LANGUAGE sql STABLE AS $$
  WITH mailed AS (
    SELECT m.batch,
           coalesce(m.arrived_at, m.drop_date) AS arrived,
           (SELECT min(l.created_at) FROM leads l
             WHERE l.mail_record_id = m.id AND coalesce(l.is_junk, false) = false) AS first_inbound
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
    FROM timed
    WHERE days IS NOT NULL
    GROUP BY 1, 2
  ),
  weekly AS (
    SELECT batch, jsonb_object_agg(week::text, n ORDER BY week) AS weekly
    FROM weeks
    GROUP BY 1
  )
  stats AS (
    SELECT batch,
           count(*) AS pieces,
           count(*) FILTER (WHERE first_inbound IS NOT NULL) AS responders,
           -- percentile_cont skips nulls: records without an arrival date or
           -- a response are out of the distribution but still counted above.
           round((percentile_cont(0.5)  WITHIN GROUP (ORDER BY days))::numeric, 1) AS median_days,
           round((percentile_cont(0.25) WITHIN GROUP (ORDER BY days))::numeric, 1) AS p25_days,
           round((percentile_cont(0.75) WITHIN GROUP (ORDER BY days))::numeric, 1) AS p75_days
    FROM timed
    GROUP BY 1
  )
  SELECT s.batch, s.pieces, s.responders, s.median_days, s.p25_days, s.p75_days,
         coalesce(w.weekly, '{}'::jsonb) AS weekly
  FROM stats s
  LEFT JOIN weekly w ON w.batch IS NOT DISTINCT FROM s.batch
  ORDER BY s.batch NULLS LAST;
$$;

-- Same report restricted to one creative, for the A/B piece children
-- (campaigns.parent_campaign_id + campaigns.piece) whose records live on the
-- parent. Keep in lockstep with mail_response_timing: the only difference is
-- the `AND m.piece = p_piece` predicate on the mailed CTE — same pattern as
-- mail_segment_stats_piece (2026-10-12_noo_q4_ab_children.sql).
CREATE OR REPLACE FUNCTION mail_response_timing_piece(p_campaign uuid, p_piece text)
RETURNS TABLE(batch int, pieces bigint, responders bigint, median_days numeric, p25_days numeric, p75_days numeric, weekly jsonb)
LANGUAGE sql STABLE AS $$
  WITH mailed AS (
    SELECT m.batch,
           coalesce(m.arrived_at, m.drop_date) AS arrived,
           (SELECT min(l.created_at) FROM leads l
             WHERE l.mail_record_id = m.id AND coalesce(l.is_junk, false) = false) AS first_inbound
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
    FROM timed
    WHERE days IS NOT NULL
    GROUP BY 1, 2
  ),
  weekly AS (
    SELECT batch, jsonb_object_agg(week::text, n ORDER BY week) AS weekly
    FROM weeks
    GROUP BY 1
  )
  stats AS (
    SELECT batch,
           count(*) AS pieces,
           count(*) FILTER (WHERE first_inbound IS NOT NULL) AS responders,
           -- percentile_cont skips nulls: records without an arrival date or
           -- a response are out of the distribution but still counted above.
           round((percentile_cont(0.5)  WITHIN GROUP (ORDER BY days))::numeric, 1) AS median_days,
           round((percentile_cont(0.25) WITHIN GROUP (ORDER BY days))::numeric, 1) AS p25_days,
           round((percentile_cont(0.75) WITHIN GROUP (ORDER BY days))::numeric, 1) AS p75_days
    FROM timed
    GROUP BY 1
  )
  SELECT s.batch, s.pieces, s.responders, s.median_days, s.p25_days, s.p75_days,
         coalesce(w.weekly, '{}'::jsonb) AS weekly
  FROM stats s
  LEFT JOIN weekly w ON w.batch IS NOT DISTINCT FROM s.batch
  ORDER BY s.batch NULLS LAST;
$$;
