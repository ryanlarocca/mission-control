# NOO Q4 2026 — Dominic's re-pull (FARM 2.0 columns): join + DNM drop + proposed dimensions

> **Status (2026-10-14):** SUPERSEDED by `BRIEF_NOO_Q4_VENDOR_V2_JOIN_2026-10-14.md` — files arrived 10/13–14; the Mail Flag / Phone / Lender / Spouse / Sales Price Code columns listed below did NOT come through, so steps 4 and 7 are moot. Original plan: agreed 2026-10-12 with Ryan's chat agent (answers relayed by Ryan). Not started. Files land in Drive `Marketing/2026/NOO October2026` as one CSV per county (same naming as Oct 2), then Ryan says "go".
> **Owner memo:** `../lead-pipeline/PROJECT_MEMO.md`. Background: `BRIEF_DM_ABSENTEE_Q4_2026_2026-10-08.md`.

## Facts (from the Zoom with Dominic, via the chat agent)

- **Same pull, columns added.** No filter changes (NOO, SFR, 11+ yr, Santa Clara / San Mateo / Santa Cruz). County currency date ≈ 2026-10-05. `Sale Date` defined as before; **`Non$ Sale Date` is a separate field — never overwrite `Sale Date` with it.**
- **New columns (FARM 2.0 labels):** Deed Type (text, 51 values — Grant Deed, Correction Deed, Affidavit of Death of Life Tenant, Transfer on Death Deed, Deed of Distribution, Executor's / Administrator's / Personal Representative's Deed, Gift Deed, Divorce/Dissolution Transfer, Trustee's Deed, Individual Deed …; it is the most recent recorded document even when ownership didn't change), Non$ Sale Date, Non$ Document Number, Tax Delinquent (Y/blank), Tax Delinquent Year(s) (format unknown), Tax Amount, Tax Exemption Code (homeowner's exemption ⇒ owner-occupied), Loan Amount / Loan Type / Interest Rate / Lender Name (blank ≈ free and clear), Owner Type (C corporate / T trust / blank individual), Owner1 Spouse First Name, Assessed Improvement Value, Total Assessed Value, Total Market Value, Distressed Status (NOD/NOS, undated, often stale), **Mail Flag ("DNM" = do not mail)**, Phone + Phone Flag (flag meaning unknown), Prior Sale Date / Prior Sales Price / Prior Buyer1 Last Name, Effective Year Built, Air Conditioning, Sales Price Code (may explain the ~48% blank Sales Price).
- **Not available:** owner age, NCOA/vacancy, email, direct equity. Equity ≈ Total Market Value − Loan Amount.
- **Join key:** Parcel Number, requested as the first column. Normalize both sides (strip dashes/spaces, compare as strings).
- **Test design unchanged.** Arms, batches, creative randomization stay as built.

## Steps on "go"

1. Download the three files byte-exact (`_tmp_dm2026/download.mjs` pattern), MD5s recorded, originals never modified (they go to `Raw Data/` like before).
2. Reconcile row counts per county against the Oct 2 files (expect 28,508 / 8,897 / 5,054 or explain the delta).
3. Join onto `master_absentee_import` / `mail_records` by normalized APN. Report: match rate, unmatched APNs both directions, fill rate per new column, value distributions for Deed Type / Owner Type / Mail Flag / Tax Delinquent / Distressed / Phone Flag / Sales Price Code.
4. **DNM drop:** rows among the 16,276 mailed with `Mail Flag = DNM` → removed from the mailing (arm stays, add `dnm = true`; they drop out of the mail-house files and `pieces_sent`), inserted into the internal DNC (`dnc_list` with parcel + site + mailing address, which mirrors to `suppression`). Report the count by arm/piece/batch. Regenerate the eight mail-house files + master, re-import with reconciliation (counts before/after must tie), re-upload to Drive (replace in place).
5. Store every new column on `mail_records` (typed where reporting needs it: deed_type, non_dollar_sale_date, tax_delinquent, tax_amount, tax_exemption_code, loan_amount, loan_type, interest_rate, lender, owner_type_vendor, spouse_first, assessed_improvement_value, total_assessed_value, total_market_value, distressed_status, mail_flag, phone, phone_flag, prior_sale_date, prior_sales_price, effective_year_built, sales_price_code) plus all of them in `raw`.
6. **Propose** dimensions for Ryan's sign-off, only where fill rates support them: deed-type groups (death/estate · trust · gift/divorce · sale · correction/other), tax delinquent Y/N, free-and-clear vs loan (and loan-age / rate bands), assessed-to-market ratio bands (proxy for Prop-13 basis / long hold), spouse blank vs present (widow/widower proxy), distressed tag, no-remodel flag (Effective Year Built = Year Built), equity bands. Build nothing until he picks.
7. **Phone column — a tracking win to propose:** with a phone per record, `suggestMailRecord` can match an inbound caller to the mailed record by number before any address is spoken. Spec it; don't build without sign-off.

## Audit trail requirement

Every row accounted for; counts reconcile before and after the join and after the DNM drop; the Oct 2 originals and the new originals both untouched.
