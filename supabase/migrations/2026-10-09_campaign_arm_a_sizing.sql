-- Arm A sizing for direct-mail list builds (NOO Q4 2026, 2026-10-09).
-- Ryan sets a tenure floor on the no-signal pool and trims zips from Arm A
-- only (trimmed rows stay in the file as arm = none; this is NOT the Step 6
-- zip cut). The picker at /campaigns/zips (Arm A mode) reads and writes
-- these; the list-build Step 9 reads them back as the Arm A rule. Idempotent.

-- Per (zip, county): no-signal pool rows by half-year tenure floor, e.g.
-- {"22.0": 31, "22.5": 28, ...} = rows with tenure in [22.0, 22.5). Null on
-- zips the Step 6 cut removed (no pool rows).
ALTER TABLE campaign_zips ADD COLUMN IF NOT EXISTS arm_a_hist jsonb;
ALTER TABLE campaign_zips ADD COLUMN IF NOT EXISTS arm_a_trim boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS campaign_list_params (
  campaign_id uuid PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  arm_a_tenure_floor numeric,
  arm_a_target integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Arm B is fixed before Arm A is sized; stored so the picker can show the mailed total.
ALTER TABLE campaign_list_params ADD COLUMN IF NOT EXISTS arm_b_count integer;
