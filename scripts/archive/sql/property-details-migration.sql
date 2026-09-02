-- Property details — structured, scannable per-property specs extracted from
-- call transcripts and rendered as an editable block under the AI summary on
-- the lead card. A single contact can own MULTIPLE properties (e.g. a seller
-- with a duplex AND a single-family), so this is an ARRAY of property objects,
-- not a single object.
--
-- Shape (all fields nullable strings except the array itself):
--   [{ label, property_type, units, unit_mix, rents, occupancy,
--      square_footage, lot_size, year_built, notes }, ...]
--
-- Populated by both Haiku passes (analyzeCallTranscript on new calls, and the
-- /summary route fired on card expand) via a sticky per-property merge that
-- fills empty fields and never drops a previously-captured property. Ryan can
-- hand-edit every field + add/remove properties on the card (PATCH /api/leads).
--
-- Idempotent: safe to re-run.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS property_details jsonb;
