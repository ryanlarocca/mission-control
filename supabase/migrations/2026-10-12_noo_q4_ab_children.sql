-- NOO Q4 2026 A/B piece plumbing (2026-10-12) — see
-- briefs/BRIEF_NOO_Q4_AB_PLUMBING_2026-10-12.md.
--
-- One list, two letters: piece A = bullets, piece B = prose. The dialed line /
-- emailed alias decides the piece (lead.source = NOO-Q4-2026-A / -B); the
-- mail_records.piece on the matched record is the cross-check.
--
-- 1. campaigns.piece — which creative a child campaign row represents.
-- 2. Two child rows under the NOO Q4 2026 parent (source_label NOO-Q4-2026),
--    found by parent_campaign_id + piece. drop_date copied from the parent.
-- 3. mail_segment_stats_piece(campaign, piece) — same body as
--    mail_segment_stats (2026-10-10_mail_records_piece.sql) restricted to one
--    piece, so GET /api/campaigns/[id]/segments can report a child's
--    segments against the parent's records.
-- Idempotent — safe to re-run.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS piece text;
COMMENT ON COLUMN campaigns.piece IS 'Creative version this (child) campaign row represents: A = bullets, B = prose; null = not an A/B child';

INSERT INTO campaigns (name, channel, drop_date, variant, source_label, piece, parent_campaign_id, notes)
SELECT 'NOO Q4 2026 — A (bullets)', 'direct_mail', p.drop_date, 'noo-q4-2026-a', 'NOO-Q4-2026-A', 'A', p.id,
       'A/B child of NOO Q4 2026: offer as four bullets. Line 408-418-6294, alias ryansvx@lrghomes.com. Records live on the parent (mail_records.piece = A).'
FROM campaigns p
WHERE p.source_label = 'NOO-Q4-2026'
  AND NOT EXISTS (SELECT 1 FROM campaigns WHERE source_label = 'NOO-Q4-2026-A');

INSERT INTO campaigns (name, channel, drop_date, variant, source_label, piece, parent_campaign_id, notes)
SELECT 'NOO Q4 2026 — B (prose)', 'direct_mail', p.drop_date, 'noo-q4-2026-b', 'NOO-Q4-2026-B', 'B', p.id,
       'A/B child of NOO Q4 2026: same offer as prose. Line 408-418-8450, alias ryansvy@lrghomes.com. Records live on the parent (mail_records.piece = B).'
FROM campaigns p
WHERE p.source_label = 'NOO-Q4-2026'
  AND NOT EXISTS (SELECT 1 FROM campaigns WHERE source_label = 'NOO-Q4-2026-B');

-- Segment report restricted to one piece. Keep in lockstep with
-- mail_segment_stats: the only difference is the `AND m.piece = p_piece`
-- predicate on the mailed CTE.
CREATE OR REPLACE FUNCTION mail_segment_stats_piece(p_campaign uuid, p_piece text)
RETURNS TABLE(dimension text, segment text, pieces bigint, responders bigint)
LANGUAGE sql STABLE AS $$
  WITH mailed AS (
    SELECT m.*,
           EXISTS (SELECT 1 FROM leads l WHERE l.mail_record_id = m.id AND coalesce(l.is_junk, false) = false) AS responded
    FROM mail_records m
    WHERE m.campaign_id = p_campaign AND m.is_seed = false AND m.arm IN ('A', 'B', 'C')
      AND m.piece = p_piece
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
