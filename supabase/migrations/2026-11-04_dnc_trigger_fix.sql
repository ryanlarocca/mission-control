-- DNC trigger fix (Ryan approved 2026-11-03 — opt-out audit, Phase 1).
--
-- Bug: the 2026-10-08 rewrite of suppression_sync_from_lead() read fields off
-- a generic `mr record` that was only assigned when the lead already carried
-- a mail_record_id. For every unlinked lead, flipping is_dnc = true raised
-- `record "mr" is not assigned yet`, and because the trigger is AFTER UPDATE
-- the whole leads UPDATE rolled back. Net effect 10-08 → 11-03: zero leads
-- could be flagged DNC (AI auto-DNC, SMS STOP, the card's DNC button, the
-- drip engine's hard stop) and the analyzer's other fields on those rows
-- were lost with it. Errors were only console-logged.
--
-- Fix: scalar variables, always assigned (NULL when there's no record).
-- New: when a DNC'd lead gets linked to a mailed record LATER (address found
-- after the opt-out), the lead_dnc suppression row is refreshed with the
-- record's parcel / site / mailing address — so the mail scrub can match it.
--
-- Also brings the dnc_list → suppression trigger (previously only in
-- scripts/archive/sql/2026-07-17-suppression-triggers.sql) into migrations,
-- unchanged except that an UPDATE of a dnc_list row's address now flows to
-- its suppression row too.
-- Idempotent — safe to re-run.

CREATE OR REPLACE FUNCTION suppression_sync_from_lead() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r_parcel text; r_site text; r_city text; r_zip text;
  r_mail text; r_mail_city text; r_mail_state text; r_mail_zip text;
  r_county text; r_owner text;
BEGIN
  IF new.mail_record_id IS NOT NULL THEN
    SELECT parcel_number, site_address, site_city, site_zip, mail_address, mail_city, mail_state, mail_zip, county, owner_name
      INTO r_parcel, r_site, r_city, r_zip, r_mail, r_mail_city, r_mail_state, r_mail_zip, r_county, r_owner
      FROM mail_records WHERE id = new.mail_record_id;
  END IF;

  IF new.is_dnc = true AND (tg_op = 'INSERT' OR coalesce(old.is_dnc, false) = false) THEN
    INSERT INTO suppression
      (email, phone, name, parcel_number, site_address, site_city, site_state, site_zip,
       mail_address, mail_city, mail_state, mail_zip, county, reason, source, source_ref, channel, audience)
    VALUES (
      lower(nullif(trim(new.email), '')),
      nullif(right(regexp_replace(coalesce(new.caller_phone, ''), '\D', '', 'g'), 10), ''),
      coalesce(new.name, r_owner),
      r_parcel,
      coalesce(r_site, new.property_address),
      r_city,
      CASE WHEN r_site IS NOT NULL THEN 'CA' ELSE NULL END,
      r_zip,
      r_mail, r_mail_city, r_mail_state, r_mail_zip, r_county,
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
  ELSIF tg_op = 'UPDATE' AND new.is_dnc = true
        AND new.mail_record_id IS NOT NULL
        AND new.mail_record_id IS DISTINCT FROM old.mail_record_id THEN
    -- Address learned after the opt-out: enrich the existing suppression row.
    UPDATE suppression SET
      name = coalesce(name, r_owner),
      parcel_number = r_parcel,
      site_address = coalesce(r_site, site_address),
      site_city = r_city,
      site_state = CASE WHEN r_site IS NOT NULL THEN 'CA' ELSE site_state END,
      site_zip = r_zip,
      mail_address = r_mail, mail_city = r_mail_city, mail_state = r_mail_state, mail_zip = r_mail_zip,
      county = r_county,
      reason = 'lead marked DNC in Mission Control (mailed record attached)'
    WHERE source = 'lead_dnc' AND source_ref = new.id::text;
  END IF;
  RETURN new;
END $$;

DROP TRIGGER IF EXISTS trg_suppression_sync_lead ON leads;
CREATE TRIGGER trg_suppression_sync_lead
  AFTER INSERT OR UPDATE OF is_dnc, mail_record_id ON leads
  FOR EACH ROW EXECUTE FUNCTION suppression_sync_from_lead();

CREATE OR REPLACE FUNCTION suppression_sync_from_dnc_list() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l_email text; l_phone text;
BEGIN
  IF tg_op = 'INSERT' THEN
    SELECT email, caller_phone INTO l_email, l_phone FROM leads WHERE id = new.source_lead_id;
    INSERT INTO suppression
      (email, phone, name, parcel_number, site_address, site_city, site_state, site_zip,
       mail_address, mail_city, mail_state, mail_zip, county, reason, source, source_ref,
       channel, audience)
    VALUES (
      lower(nullif(trim(l_email), '')),
      nullif(right(regexp_replace(coalesce(l_phone, ''), '\D', '', 'g'), 10), ''),
      new.owner_name,
      new.parcel_number, new.site_address, new.site_city, new.site_state, new.site_zip,
      new.mail_address, new.mail_city, new.mail_state, new.mail_zip, new.county,
      coalesce(new.reason, 'dnc_list entry'),
      'dnc_list',
      new.id::text,
      'all',
      'seller'
    )
    ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING;
    RETURN new;
  ELSIF tg_op = 'UPDATE' THEN
    UPDATE suppression SET
      name = new.owner_name,
      parcel_number = new.parcel_number,
      site_address = new.site_address, site_city = new.site_city, site_state = new.site_state, site_zip = new.site_zip,
      mail_address = new.mail_address, mail_city = new.mail_city, mail_state = new.mail_state, mail_zip = new.mail_zip,
      county = new.county
    WHERE source = 'dnc_list' AND source_ref = new.id::text;
    RETURN new;
  ELSIF tg_op = 'DELETE' THEN
    DELETE FROM suppression WHERE source = 'dnc_list' AND source_ref = old.id::text;
    RETURN old;
  END IF;
  RETURN new;
END $$;

DROP TRIGGER IF EXISTS trg_suppression_sync_dnc_list ON dnc_list;
CREATE TRIGGER trg_suppression_sync_dnc_list
  AFTER INSERT OR UPDATE OR DELETE ON dnc_list
  FOR EACH ROW EXECUTE FUNCTION suppression_sync_from_dnc_list();
