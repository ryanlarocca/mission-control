-- NOO Q4 2026 vendor re-pull (v2): Dominic's re-scrubbed county files
-- (2026-10-13/14) carry 20 columns the Oct 2 pull did not. Store them on
-- mail_records beside the originals so the Segments panel / lead card can use
-- them later (dimensions are a separate decision — brief
-- BRIEF_NOO_Q4_VENDOR_V2_JOIN_2026-10-14 §4; this migration does NOT touch
-- mail_segment_stats / mail_segment_stats_piece).
--
-- Written only by scripts/join-mail-records-v2.mjs, matched on normalized APN.
-- sale_date / owner_name are NEVER overwritten: the v2 values live in
-- vendor_v2_sale_date / vendor_v2_owner_name. owner_type (list-build tag) is
-- untouched; the vendor's Owner Type lands in owner_type_vendor.
-- Idempotent — safe to re-run.

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS deed_type text;
COMMENT ON COLUMN mail_records.deed_type IS 'v2 "Deed Type" — trimmed, blank = null (Grant Deed, Gift Deed, Correction Deed, …)';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS non_dollar_sale_date date;
COMMENT ON COLUMN mail_records.non_dollar_sale_date IS 'v2 "Non$ Sale Date" (MM/DD/YYYY in the file)';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS non_dollar_doc_number text;
COMMENT ON COLUMN mail_records.non_dollar_doc_number IS 'v2 "Non$ Document Number"';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS tax_delinquent boolean;
COMMENT ON COLUMN mail_records.tax_delinquent IS 'v2 "Tax Delinquent": Y = true, N = false, blank = null';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS tax_delinquent_years text;
COMMENT ON COLUMN mail_records.tax_delinquent_years IS 'v2 "Tax Delinquent Year(s)" verbatim, e.g. "2025, 2024"';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS tax_amount numeric;
COMMENT ON COLUMN mail_records.tax_amount IS 'v2 "Tax Amount"';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS tax_exemption_code text;
COMMENT ON COLUMN mail_records.tax_exemption_code IS 'v2 "Tax Exemption Code" verbatim: None / Yes (H)';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS homeowner_exemption boolean;
COMMENT ON COLUMN mail_records.homeowner_exemption IS 'true iff tax_exemption_code starts with "Yes" (homeowner''s exemption → likely owner-occupied despite NOO); null when blank';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS loan_amount numeric;
COMMENT ON COLUMN mail_records.loan_amount IS 'v2 "Loan Amount"; null = no loan on record (≈ free and clear)';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS loan_amount_2nd numeric;
COMMENT ON COLUMN mail_records.loan_amount_2nd IS 'v2 "Loan Amount 2nd"';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS loan_type text;
COMMENT ON COLUMN mail_records.loan_type IS 'v2 "Loan Type": O / F / V';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS owner_type_vendor text;
COMMENT ON COLUMN mail_records.owner_type_vendor IS 'v2 "Owner Type" from the vendor: T / C / Ct. Distinct from owner_type (list-build tag), which is untouched';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS assessed_improvement_value numeric;
COMMENT ON COLUMN mail_records.assessed_improvement_value IS 'v2 "Assessed Improvement Value"';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS total_assessed_value numeric;
COMMENT ON COLUMN mail_records.total_assessed_value IS 'v2 "Total Assessed Value"';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS total_market_value numeric;
COMMENT ON COLUMN mail_records.total_market_value IS 'v2 "Total Market Value" — blank on every row of the 2026-10-14 files; column kept for a future export';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS distressed_status text;
COMMENT ON COLUMN mail_records.distressed_status IS 'v2 "Distressed Status": Nod / Nos; null = none';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS prior_sale_date date;
COMMENT ON COLUMN mail_records.prior_sale_date IS 'v2 "Prior Sale Date"';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS prior_sales_price numeric;
COMMENT ON COLUMN mail_records.prior_sales_price IS 'v2 "Prior Sales Price"';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS prior_buyer1_last text;
COMMENT ON COLUMN mail_records.prior_buyer1_last IS 'v2 "Prior Buyer1 Last Name"';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS effective_year_built integer;
COMMENT ON COLUMN mail_records.effective_year_built IS 'v2 "Effective Year Built"';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS air_conditioning text;
COMMENT ON COLUMN mail_records.air_conditioning IS 'v2 "Air Conditioning" code verbatim (N / Y / C / O / L — county-specific coding)';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS vendor_v2_sale_date date;
COMMENT ON COLUMN mail_records.vendor_v2_sale_date IS 'v2 file "Sale Date". NEVER copied into sale_date — a later value means the parcel sold since the Oct 2 pull';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS vendor_v2_owner_name text;
COMMENT ON COLUMN mail_records.vendor_v2_owner_name IS 'v2 file "Owner Name". NEVER copied into owner_name';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS vendor_v2_at timestamptz;
COMMENT ON COLUMN mail_records.vendor_v2_at IS 'When scripts/join-mail-records-v2.mjs last wrote the v2 columns on this row; null = not matched in any v2 file';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS vendor_v2_file text;
COMMENT ON COLUMN mail_records.vendor_v2_file IS 'Basename of the v2 county file the row was matched in';

ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS raw_v2 jsonb;
COMMENT ON COLUMN mail_records.raw_v2 IS 'The whole v2 row, header → verbatim string (like raw for the Oct 2 file)';

CREATE INDEX IF NOT EXISTS idx_mail_records_homeowner_exemption ON mail_records(campaign_id, homeowner_exemption);
