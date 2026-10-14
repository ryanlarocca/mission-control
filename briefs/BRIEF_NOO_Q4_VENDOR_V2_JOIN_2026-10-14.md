# NOO Q4 2026 — vendor re-pull (v2) join: intake findings + cloud build spec

> **Status (2026-10-14 pm):** intake DONE · Task 1 BUILT and on `main` (`7fd0c5c` cloud + `090a8de` / `660432e` / `60b241f` Mac-mini fixes: NOT NULL echo in the upsert, lenient stray-quote CSV rule, county-scoped APN index) · dry run against prod reconciles (28,191 matched / 10 unmatched / 4 seeds / 36 sale-date drifts) · **§3 steps 2–3 (apply migration, `--commit`) NOT run — the auto-mode permission classifier refused `run-migration.mjs` as a production deploy; Ryan runs or approves the two commands in `../lead-pipeline/PROJECT_MEMO.md`.** Drive Raw Data upload done. Ryan 2026-10-14: DNM is not a gate (moot anyway — see §1). Dimensions in §4 await Ryan's pick.
> **Owner memo:** `../lead-pipeline/PROJECT_MEMO.md`. Plan: `BRIEF_NOO_Q4_DOMINIC_REPULL_2026-10-12.md`. Background: `BRIEF_DM_ABSENTEE_Q4_2026_2026-10-08.md`.

## 1. Intake (2026-10-14, read-only)

Source: two emails from Dominic (Chicago Title) to ryan@ — 10/13 "Your lists re-scrubbed for the Overlord's review" (Santa Clara + Santa Cruz) and 10/14 "SM County data refreshed with new columns" (San Mateo). Downloaded byte-exact via `_tmp_dm2026/fetch_v2.mjs` into `_tmp_dm2026/raw_v2/`. Oct 2 originals in `_tmp_dm2026/raw/` untouched.

| File | Oct 2 rows / md5 | v2 rows / bytes / md5 | APN both | old-only | new-only |
|---|---|---|---|---|---|
| ALL SC Co NOO SFR 11+ yr.csv | 28,508 / f99c9a66… | 28,504 / 13,641,311 / 744d7e16… | 28,504 | 4 | 0 |
| ALL SM Co NOO SFR 11+ yr.csv | 8,897 / 40d17cdd… | 8,883 / 4,401,051 / 84daecf2… | 8,878 | 19 | 5 |
| ALL Santa Cruz Co NOO SFR 11+ yr.csv | 5,054 / 393098a1… | 5,054 / 2,452,735 / b723857c… | 5,054 | 0 | 0 |

**Columns.** All three files: the 43 original columns in the original order, with `Deed Type` inserted at position 34 (after `Sales Price`) and 19 more appended after `Seller1 Last Name`:
`Non$ Sale Date, Non$ Document Number, Tax Delinquent, Tax Delinquent Year(s), Tax Amount, Tax Exemption Code, Loan Amount, Loan Amount 2nd, Loan Type, Owner Type, Assessed Improvement Value, Total Assessed Value, Total Market Value, Distressed Status, Prior Sale Date, Prior Sales Price, Prior Buyer1 Last Name, Effective Year Built, Air Conditioning`. No column removed. Quoted CSV (RFC 4180), utf-8 with BOM.

**Promised but ABSENT in every file:** `Mail Flag` (DNM), `Phone`, `Phone Flag`, `Interest Rate`, `Lender Name`, `Owner1 Spouse First Name`, `Sales Price Code`. `Total Market Value` is present but 100% blank. ⇒ the DNM drop and the phone-match tracking idea (repull brief steps 4 and 7) are moot until Dominic can export those columns. `Loan Amount 2nd` arrived unannounced.

**Sale Date drift.** SC: 46 shared APNs have a new Sale Date (max 2026-10-05); Santa Cruz: 3 (max 2026-09-25); SM: 0 (max still 12/31/2014 — the SM file was refreshed differently). These are sales recorded since the Oct 2 pull. **Never overwrite `mail_records.sale_date`** — store the v2 value beside it.

**Mailed set (16,276 non-seed rows, parent campaign NOO Q4 2026):** 16,268 matched by normalized APN, 8 unmatched (SC: NOO26-18246, NOO26-20602; SM: NOO26-25232, -25404, -26083, -26121, -26178, -26353 — parcels that dropped out of the county file). On the matched rows:

| Signal | Count | Arm A | Arm B | Note |
|---|---|---|---|---|
| Sold since the pull (v2 Sale Date ≠ Oct 2) | 21 | 11 | 10 | letters will reach a new owner |
| Homeowner's exemption `Yes (H)` | 2,534 (15.6%) | 1,632 | 902 | likely owner-occupied despite NOO=N — biggest finding |
| Tax delinquent `Y` | 459 | 281 | 178 | spread evenly over batches (18–40 per batch×piece×arm) |
| No loan on record (≈ free and clear) | 9,325 (57%) | 6,099 | 3,226 | `Loan Amount` blank |
| Owner Type T / C / Ct | 1,054 / 143 / 72 | | | `Ct` = new value (corporate trust?) — ask Dominic |
| Distressed (NOD/NOS) | 7 | | | undated |
| Owner Name changed vs master | 32 | | | |

Deed Type on mailed rows: Grant 6,980 · blank 6,530 · Correction 1,202 · Individual 788 · Gift 448 · Re-Recorded 93 · Corporation 74 · Other 72 · Trustee's 23 · Deed 18 · Joint Tenancy 11 · Affidavit 8 · Administrator's 5 · Executor's 4 · Na 4 · Warranty 2 · one each of Deed Of Distribution, Bargain And Sale, Deed In Lieu, Conservator's, Partnership, Personal Representatives.

File-wide fill rates (SC / SM / Santa Cruz): Deed Type 64/82/65% · Non$ Sale Date 84/88/85% · Tax Delinquent 96/100/100% (Y: 785 / 241 / 59) · Tax Amount 96/100/100% · Tax Exemption Code 100% (`Yes (H)`: 3,975 / 1,988 / 935) · Loan Amount 44/54/39% · Loan Amount 2nd 4/5/3% · Loan Type 23/28/21% (O/F/V) · Owner Type 8/13/13% · Assessed Improvement Value ≈100% · Total Assessed Value ≈100% · Prior Sale Date 31/41/59% · Prior Sales Price 26/32/33% · Prior Buyer1 Last Name 31/39/31% · Effective Year Built 12/32/12% · Air Conditioning 18/99/39% (values N / Y / C / O / L — county-specific coding) · Distressed 5 / 4 / 2 rows.

## 2. Task 1 — store v2 columns on `mail_records` (cloud, branch `cloud/mail-records-vendor-v2`)

Code only. No database or secrets in the cloud: write the migration, don't apply it; the join script must run without a database in `--dry-run`/fixture mode. Read `CLAUDE.md` first. `npx tsc --noEmit` and `npx vitest run` must pass before pushing. No PR, no merge; push the branch and stop.

### 2a. Migration `supabase/migrations/2026-10-14_mail_records_vendor_v2.sql` (idempotent)

`ALTER TABLE mail_records ADD COLUMN IF NOT EXISTS` for each, with a `COMMENT ON COLUMN`:

| column | type | source column | parse |
|---|---|---|---|
| deed_type | text | Deed Type | trim, blank→null |
| non_dollar_sale_date | date | Non$ Sale Date | MM/DD/YYYY |
| non_dollar_doc_number | text | Non$ Document Number | |
| tax_delinquent | boolean | Tax Delinquent | `Y`→true, `N`→false, blank→null |
| tax_delinquent_years | text | Tax Delinquent Year(s) | verbatim, e.g. `2025, 2024` |
| tax_amount | numeric | Tax Amount | |
| tax_exemption_code | text | Tax Exemption Code | `None` / `Yes (H)` |
| homeowner_exemption | boolean | Tax Exemption Code | true iff value starts with `Yes` |
| loan_amount | numeric | Loan Amount | |
| loan_amount_2nd | numeric | Loan Amount 2nd | |
| loan_type | text | Loan Type | O / F / V |
| owner_type_vendor | text | Owner Type | T / C / Ct (keep `owner_type` = list-build tag untouched) |
| assessed_improvement_value | numeric | Assessed Improvement Value | |
| total_assessed_value | numeric | Total Assessed Value | |
| total_market_value | numeric | Total Market Value | blank today; keep the column |
| distressed_status | text | Distressed Status | Nod / Nos |
| prior_sale_date | date | Prior Sale Date | |
| prior_sales_price | numeric | Prior Sales Price | |
| prior_buyer1_last | text | Prior Buyer1 Last Name | |
| effective_year_built | integer | Effective Year Built | |
| air_conditioning | text | Air Conditioning | verbatim code |
| vendor_v2_sale_date | date | Sale Date (v2 file) | **never written to `sale_date`** |
| vendor_v2_owner_name | text | Owner Name (v2 file) | |
| vendor_v2_at | timestamptz | — | set by the join script on write |
| vendor_v2_file | text | — | source file name |
| raw_v2 | jsonb | whole v2 row | header→value, verbatim strings |

Index: `CREATE INDEX IF NOT EXISTS idx_mail_records_homeowner_exemption ON mail_records(campaign_id, homeowner_exemption)`. Do **not** touch `mail_segment_stats` / `mail_segment_stats_piece` in this task (dimensions are a separate decision, §4).

### 2b. Script `scripts/join-mail-records-v2.mjs`

```
node --env-file=.env.local scripts/join-mail-records-v2.mjs --campaign <uuid> --file <csv> [--file <csv> …] [--commit]
```

Model on `scripts/import-mail-records.mjs` (same CSV parser — extract it to `lib/csv.ts` and have both scripts import it; keep RFC 4180 behaviour, strip a leading BOM). Dry-run by default.

1. Parse every `--file`. Required headers: `Parcel Number`, `Owner Name`, `Sale Date` plus the 20 v2 columns listed above; hard-fail if any is missing, warn (don't fail) on extra columns. Fail on duplicate normalized APN across files.
2. `normApn(s)` = uppercase, strip everything that is not `[0-9A-Z]` (`050-273-520` → `050273520`). Export it from `lib/mailMatch.ts` next to the other normalizers.
3. Load every `mail_records` row for the campaign: `id, record_id, parcel_number, parcels, parcel_count, sale_date, owner_name, is_seed` — ordered paging (`.order("record_id").range(…)`, 1,000 per page; the repo rule is `.order` before `.range`).
4. Match: primary = `normApn(parcel_number)`; if no hit and `parcels` is non-empty (pipe-separated), try each in order and take the first hit (count these as `matched_via_secondary_parcel`). Seeds (`is_seed` or blank parcel) are skipped and reported separately.
5. Build the update per matched row from the table in §2a; `raw_v2` = the full v2 row; `vendor_v2_file` = basename of the file it came from; `vendor_v2_at` = now. **Only these columns are written** — never `sale_date`, `owner_name`, `arm`, `batch`, `piece`, `raw`, or the match-key columns.
6. Report (always, before any write): rows per file; mail_records rows for the campaign; matched / matched_via_secondary_parcel / unmatched record_ids (list them all — expect ~8 + 4 seeds); v2 APNs not present in mail_records (count only); per-column fill rate on the matched set; value distributions for `deed_type`, `owner_type_vendor`, `tax_delinquent`, `homeowner_exemption`, `loan_type`, `distressed_status`, `air_conditioning`; count of rows where `vendor_v2_sale_date ≠ sale_date` with the record_ids and both dates; count where `vendor_v2_owner_name ≠ owner_name`.
7. `--commit`: update in batches of 500 by `id` (`.update(...).eq("id", …)` per row is too slow for 28k — use `upsert` on `id` with **only** the v2 columns plus `id` and `campaign_id`, `onConflict: "id"`; PostgREST upsert leaves unspecified columns alone). Afterwards re-read `id, vendor_v2_at, sale_date` for the campaign and assert: rows with `vendor_v2_at` set == matched count; total row count unchanged; `sale_date` unchanged on a 200-row sample captured before the write. Exit 2 on any reconciliation failure, 3 on a Supabase error.
8. Idempotent — re-running overwrites the same v2 columns.

### 2c. Tests

- `tests/fixtures/vendor_v2_sample.csv` is committed (header + 3 synthetic rows, quoted like the vendor file, with a BOM). Extend it if you need more cases but keep it synthetic.
- `tests/mail-records-vendor-v2.unit.test.ts`: `normApn` cases (`050-273-520`, `058 702 030`, lowercase letters, already-normalized); the row→update mapping for each column type (Y/N/blank booleans, `Yes (H)`→`homeowner_exemption=true`, `None`→false, dates, numerics with blanks, `vendor_v2_sale_date` populated while no `sale_date` key exists in the update object); the matcher (primary hit, secondary-parcel hit, miss, seed skipped). Export the pure functions from the script (or a `lib/mailRecordsV2.ts` the script imports) so they are testable without a database.

### 2d. Report back

Migration path, script usage line, test names, and anything you could not verify without a database.

## 3. Mac mini steps after the branch lands

1. ✅ Fetched, reviewed, merged, fixed (three gotchas, see status), `tsc` + 246 tests green, on `main`, main checkout fast-forwarded, remote branch deleted.
2. ⏳ `node scripts/run-migration.mjs supabase/migrations/2026-10-14_mail_records_vendor_v2.sql` — refused by the permission classifier from the bridge session; Ryan runs it.
3. ✅ Dry run done (list-wide: 28,191 matched / 10 unmatched = the 8 mailed + NOO26-23507, NOO26-26251 unmailed / 4 seeds / 36 drifts, 21 of them mailed — ties to §1). ⏳ `--commit` pending Ryan (after step 2).
4. ✅ Uploaded the three v2 originals to Drive `Marketing/2026/NOO October2026/Raw Data/` as `v2 2026-10-14 - <name>` (MD5s tie).
5. Wrap: CHANGELOG + PROJECT_MEMO in `../lead-pipeline/`, memory, delete the remote branch.

## 4. Proposed dimensions (for Ryan to pick — build nothing until then)

Fill rates support these on the mailed set; each would be one more `(dimension, segment)` line in `mail_segment_stats` / `_piece`:

1. **homeowner_exemption** yes/no — 2,534 mailed rows carry the exemption. If they respond at a different rate it says whether "NOO" from the plant is trustworthy; if they are really owner-occupants they may also be a future exclusion (or a different letter).
2. **tax_delinquent** yes/no — 459 rows; classic distress signal.
3. **loan_status** free-and-clear (no loan) / loaned — 57% / 43%.
4. **deed_group** sale (Grant/Individual/Warranty/Bargain and Sale/Joint Tenancy/Corporation/Partnership) · transfer (Gift/Trustee's/Deed of Distribution) · estate (Affidavit/Administrator's/Executor's/Personal Representatives/Conservator's) · correction/other (Correction/Re-Recorded/Other/Deed/Na) · blank. Estate is tiny (≈18 rows) — fold into transfer if Ryan prefers.
5. **owner_type_vendor** trust / corporate / corporate trust / individual — overlaps the list-build `owner_type` tag; keep only if the two disagree materially (check at join time).
6. **assessed_ratio** bands of `assessed_improvement_value / total_assessed_value` — a Prop-13-basis proxy; needs a quick histogram before cutting bands.
7. **sold_since_pull** yes/no — 21 rows; too small for a segment, but worth a ⚠ chip on the lead card when a caller's record has `vendor_v2_sale_date > sale_date` ("record sold 09/28/2026 — caller may be the new owner").

Not proposed: Distressed (7 rows), Effective Year Built (12% fill in SC), Air Conditioning (county-specific coding), Total Market Value (blank), DNM / phone (absent).

## 5. Open items for Dominic (Ryan is texting him — no email needed)

- Can the farming tool export `Mail Flag`, `Phone`, `Phone Flag`, `Lender Name`, `Interest Rate`, `Owner1 Spouse First Name`, `Sales Price Code`? They were discussed but are not in the files.
- What is Owner Type `Ct`? What are the Air Conditioning codes `C`, `O`, `L`?
- Why is `Total Market Value` blank on every row?
