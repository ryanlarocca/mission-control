-- Direct-mail tracking layer (NOO Q4 2026 brief, approved by Ryan 2026-10-08).
--
-- 1. mail_records — one row per row of the final campaign file (mailed arms
--    A/B/C, seeds, and arm = 'none' rows kept so a caller who is "in the list
--    but not mailed" can still be recognised). Every tag/signal from the list
--    build is a typed column; the 43 vendor columns ride along in `raw`.
-- 2. leads.mail_record_id — the lead ↔ mailed-record link, written cluster-wide
--    (every row sharing the caller's phone/email) like is_dnc.
-- 3. suppression_sync_from_lead() — when a linked lead is DNC'd, the
--    suppression row carries parcel / site / mailing address from the record.
-- 4. mail_segment_stats(campaign) — pieces + responders per segment, used by
--    GET /api/campaigns/[id]/segments. Seeds and unmailed rows never count as
--    pieces; junk leads never count as responders.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS mail_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  record_id text NOT NULL,
  -- identity
  parcel_number text,
  owner_name text,
  owner_name2 text,
  owner1_first text,
  owner1_last text,
  owner2_first text,
  owner2_last text,
  site_address text,
  site_city text,
  site_zip text,
  mail_address text,          -- Full Mail Address (keeps the unit)
  mail_city text,
  mail_state text,
  mail_zip text,
  county text,
  -- campaign
  arm text NOT NULL CHECK (arm IN ('A', 'B', 'C', 'none', 'seed')),
  batch integer,
  drop_date date,
  arrived_at date,
  is_seed boolean NOT NULL DEFAULT false,
  -- tags
  tenure_years numeric,
  tenure_bucket text,
  imp_tercile text,
  year_built_bucket text,
  owner_type text,
  po_box boolean,
  managed boolean,
  out_of_county boolean,
  parcel_count integer,
  parcels text,
  -- signals
  estate_language boolean,
  family_transfer boolean,
  out_of_state boolean,
  multi_parcel_personal boolean,
  any_signal boolean,
  -- typed source fields for reporting
  sale_date date,
  sales_price numeric,
  year_built integer,
  assessed_improve_pct numeric,
  -- precomputed match keys (lib/mailMatch.ts normalizers)
  site_street_norm text,
  site_city_norm text,
  mail_line_norm text,
  mail_city_norm text,
  owner_surname_norm text,
  owner_name_norm text,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, record_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_records_campaign ON mail_records(campaign_id);
CREATE INDEX IF NOT EXISTS idx_mail_records_site_street ON mail_records(campaign_id, site_street_norm);
CREATE INDEX IF NOT EXISTS idx_mail_records_mail_line ON mail_records(campaign_id, mail_line_norm);
CREATE INDEX IF NOT EXISTS idx_mail_records_surname ON mail_records(campaign_id, owner_surname_norm);
CREATE INDEX IF NOT EXISTS idx_mail_records_parcel ON mail_records(parcel_number);
CREATE INDEX IF NOT EXISTS idx_mail_records_arm_batch ON mail_records(campaign_id, arm, batch);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS mail_record_id uuid REFERENCES mail_records(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS mail_match_method text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS mail_match_candidates uuid[];
CREATE INDEX IF NOT EXISTS idx_leads_mail_record ON leads(mail_record_id);

-- DNC enrichment: the lead-side trigger now copies the linked record's
-- parcel / site / mailing fields. Same (source, source_ref) idempotency,
-- same un-DNC delete, same channel/audience as before.
CREATE OR REPLACE FUNCTION suppression_sync_from_lead() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mr record;
BEGIN
  IF new.is_dnc = true AND (tg_op = 'INSERT' OR coalesce(old.is_dnc, false) = false) THEN
    IF new.mail_record_id IS NOT NULL THEN
      SELECT parcel_number, site_address, site_city, site_zip, mail_address, mail_city, mail_state, mail_zip, county, owner_name
        INTO mr FROM mail_records WHERE id = new.mail_record_id;
    END IF;
    INSERT INTO suppression
      (email, phone, name, parcel_number, site_address, site_city, site_state, site_zip,
       mail_address, mail_city, mail_state, mail_zip, county, reason, source, source_ref, channel, audience)
    VALUES (
      lower(nullif(trim(new.email), '')),
      nullif(right(regexp_replace(coalesce(new.caller_phone, ''), '\D', '', 'g'), 10), ''),
      coalesce(new.name, mr.owner_name),
      mr.parcel_number,
      coalesce(mr.site_address, new.property_address),
      mr.site_city,
      CASE WHEN mr.site_address IS NOT NULL THEN 'CA' ELSE NULL END,
      mr.site_zip,
      mr.mail_address, mr.mail_city, mr.mail_state, mr.mail_zip, mr.county,
      CASE WHEN new.mail_record_id IS NOT NULL THEN 'lead marked DNC in Mission Control (mailed record attached)'
           ELSE 'lead marked DNC in Mission Control' END,
      'lead_dnc',
      new.id::text,
      'all',
      'seller'
    )
    ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING;
  ELSIF tg_op = 'UPDATE' AND coalesce(old.is_dnc, false) = true AND new.is_dnc = false THEN
    DELETE FROM suppression WHERE source = 'lead_dnc' AND source_ref = new.id::text;
  END IF;
  RETURN new;
END $$;

DROP TRIGGER IF EXISTS trg_suppression_sync_lead ON leads;
CREATE TRIGGER trg_suppression_sync_lead
  AFTER INSERT OR UPDATE OF is_dnc ON leads
  FOR EACH ROW EXECUTE FUNCTION suppression_sync_from_lead();

-- Segment stats: pieces mailed (non-seed, arms A/B/C) and distinct mailed
-- records with at least one non-junk lead attached, per dimension × segment.
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
      ('out_of_county', CASE WHEN m.out_of_county THEN 'yes' ELSE 'no' END)
    ) AS d(dimension, segment)
  )
  SELECT dimension, coalesce(segment, 'unknown') AS segment, count(*) AS pieces, count(*) FILTER (WHERE responded) AS responders
  FROM dims
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;
