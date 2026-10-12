-- NOO Q4 2026 A/B: piece A = offer as four bullets, piece B = same offer as prose.
-- Randomized 50/50 inside arm × prior_mail × county × batch by the list build.
ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS piece text;
COMMENT ON COLUMN mail_records.piece IS 'Creative version mailed (A = bullets, B = prose); null = not mailed';

-- Segment dimension: piece.
CREATE OR REPLACE FUNCTION mail_segment_stats(p_campaign uuid)
RETURNS TABLE(dimension text, segment text, pieces bigint, responders bigint)
LANGUAGE sql STABLE AS $$
  WITH mailed AS (
    SELECT m.*,
           EXISTS (SELECT 1 FROM leads l WHERE l.mail_record_id = m.id AND coalesce(l.is_junk, false) = false) AS responded
    FROM mail_records m
    WHERE m.campaign_id = p_campaign AND m.is_seed = false AND m.arm IN ('A', 'B', 'C')
  ),
  dims AS (
    SELECT d.dimension, d.segment, m.responded
    FROM mailed m
    CROSS JOIN LATERAL (VALUES
      ('arm', m.arm),
      ('county', m.county),
      ('batch', m.batch::text),
      ('tenure_bucket', m.tenure_bucket),
      ('imp_tercile', m.imp_tercile),
      ('year_built_bucket', m.year_built_bucket),
      ('owner_type', m.owner_type),
      ('estate_language', CASE WHEN m.estate_language THEN 'yes' ELSE 'no' END),
      ('family_transfer', CASE WHEN m.family_transfer THEN 'yes' ELSE 'no' END),
      ('out_of_state', CASE WHEN m.out_of_state THEN 'yes' ELSE 'no' END),
      ('multi_parcel_personal', CASE WHEN m.multi_parcel_personal THEN 'yes' ELSE 'no' END),
      ('any_signal', CASE WHEN m.any_signal THEN 'yes' ELSE 'no' END),
      ('po_box', CASE WHEN m.po_box THEN 'yes' ELSE 'no' END),
      ('managed', CASE WHEN m.managed THEN 'yes' ELSE 'no' END),
      ('out_of_county', CASE WHEN m.out_of_county THEN 'yes' ELSE 'no' END),
      ('prior_mail', coalesce(m.prior_mail, 'fresh')),
      ('piece', coalesce(m.piece, 'unknown'))
    ) AS d(dimension, segment)
  )
  SELECT dimension, coalesce(segment, 'unknown') AS segment, count(*) AS pieces, count(*) FILTER (WHERE responded) AS responders
  FROM dims
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;
