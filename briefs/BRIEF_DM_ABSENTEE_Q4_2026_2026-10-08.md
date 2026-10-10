# Q4 2026 absentee-owner direct mail — list build + tracking

> **Status (2026-10-09, later): FINAL LIST BUILT + IMPORTED.** Two arms (Arm C scrapped Oct 8). Ryan's picker pass: tenure floor ≥ 23.0 yrs, 94066 San Bruno trimmed from Arm A → **Arm A 10,589 · Arm B 5,687 · 16,276 mailed**, 11,925 kept in the file as `arm = none`. Four stratified batches (arm × county, seed 20261009; 4,068 / 4,071 / 4,069 / 4,068), one seed per batch ("Ryan LaRocca 1–4", 4032 Ross Park Ct, San Jose 95118, `SEED-n`, excluded from every count). Mail-house files carry raw owner fields + mailing + site address (`mailhouse_all_batches.csv`, `mailhouse_batch_1–4.csv`), with `arm_a_cutoffs.csv` and `mission_control_import.csv` in the Drive main folder. `mail_records` = 28,205 rows, reconciled, `pieces_sent = 16,276`. `scripts/stamp-arrived.mjs` stamps `arrived_at` per batch when a seed lands. Owed: `campaigns.total_cost`. Tracking build as planned in Part 3 (`9ffa544`, `fa35cfd`, `55eeba2`, `1297fe9`); decisions: whole-list matching, mailing address as a key, no drop-date tracking (seeds + `arrived_at`), no lead_status_history. Owner-occupied = separate future campaign; parked: points score, holdout slice, SSA age estimate.
> **Written:** 2026-10-08 · **Owner memo:** `../lead-pipeline/PROJECT_MEMO.md` (Leads tab / Campaign Performance)
> **Scope source:** Ryan's project prompt of 2026-10-08 (two tracks: list build, tracking in Mission Control).

Working directory for the list build: `PROJECTS/_tmp_dm2026/` (venv with pandas 3.0.6, `raw/` = byte-exact Drive downloads, `out/` = step outputs, scripts `step1_consolidate.py`, `dnc_inventory.mjs`, `profile_raw.py`). Outputs upload to the Drive campaign folder once Ryan confirms the path.

---

## Part 1 — Phase 1 results so far

### Step 1 — Consolidate ✅

Drive folder found: **My Hard Drive / Marketing / 2026 / NOO October2026** (folder id `14qk007vZ5iHMPLU3lAjiOB-_o_Go0N--`, owned by the personal account, files owned by ryan@lrghomes.com). It contains exactly the three CSVs and nothing else. Downloaded via the inbox-agent DWD Drive client; local MD5s equal Drive's.

| File | County | Rows | Cols | Encoding | Partial last line | Header whitespace |
|---|---|---|---|---|---|---|
| ALL SC Co NOO SFR 11+ yr.csv | Santa Clara | 28,508 | 43 | utf-8 | none | none |
| ALL SM Co NOO SFR 11+ yr.csv | San Mateo | 8,897 | 43 | utf-8 | none | none |
| ALL Santa Cruz Co NOO SFR 11+ yr.csv | Santa Cruz | 5,054 | 43 | utf-8 | none | none |
| **master_absentee_raw.csv** | | **42,459** | 45 | | | |

- Column names and order identical across all three. Headers stripped on load anyway (no trailing whitespace in these uploads — the `"Seller1 Last Name  "` quirk was in Ryan's sample, not these files).
- Every row has `Owner Occupied = N`, `Use Code Description = Single Family Residential`, `Site Address State = CA`, and the `County` column matches the file.
- Quote-aware field-count audit: zero rows with the wrong field count in any file.
- 42,459 = 28,508 + 8,897 + 5,054 ✅. **Note: this is ~21% more than the ~35k Ryan expected.**

Profile facts that matter for later steps: `Sale Date` is always `MM/DD/YYYY`, never blank. `Sales Price` blank on 18,276 (43%). `Assessed Improve Percent` numeric 0–100, blank on 82. `Year Built` blank on 1,120. `Mail Address State` blank on 177; top non-CA: WA 409, NV 381, TX 338, OR 250, FL 196, AZ 196 (54 distinct values).

### Step 2.1 — DNC inventory (matching NOT run — waiting on Ryan)

| Table | Rows | Rows usable for a mail scrub |
|---|---|---|
| `suppression` (all channels) | 102 | — |
| `suppression` channel `mail` or `all` | **75** | 57 have a name and/or site address; **18 are phone/email only — unmatchable against a property list** |
| `dnc_list` | **24** | all 24 are already mirrored into `suppression` as `source = dnc_list` (DB trigger), so they add no new identities |

Field population on the 75 mail/all rows: name 49, site_address 42, phone 48, email 28, **parcel_number 0, site_city 0, site_zip 0, mail_address/city/zip 0, county 0** (site_state 24, all "CA"). Same zeros on `dnc_list`.

`site_address` is free text, e.g. `860 24th Ave., Santa Cruz 95062`, `1035 Bryant, Palo Alto`, `118 Bellwood Lane` (no city/zip), `San Jose, CA (duplex)`, `Junewood Ave, San Jose, CA` (no house number). A parse (street = text before the first comma; zip = 5-digit token; city = remainder minus state) splits 25 of the 26 distinct values correctly; 3 have no city or zip at all and 2 have no house number.

Names are often first-name-only or decorated (`Luz`, `Sunday`, `Yipei`, `David Perry 11plex`, `Donald Teixeira, Trustee`, `Candace Berenguer (Roman Catholic Bishop of San Jose)`).

### Steps 3–4 — not run (they consume Step 2's output)

Preview only, on the raw file, to size one decision: substring vs whole-word pattern matching for owner-type exclusions.

| Pattern | Substring hits | Whole-word hits | What substring wrongly catches |
|---|---|---|---|
| USA | 507 | 2 | SUSAN, KAUSALYA, SUSANA |
| HUD | 21 | 0 | HUDSON, HUDNUT, HUDDA |
| BANK | 41 | 21 | BANKS, EUBANKS, MARCHBANKS |
| CHURCH | 76 | 73 | CHURCHILL, CHRISTCHURCH INVESTMENTS TRUST |
| LLP | 4 | 0 | KILLPACK, WILLPITZ (and misses `WINMAR & COMPANY LLLP`) |
| TEMPLE | 8 | 7 | TEMPLETON |
| TRICON | 1 | 0 | CASTRICONE |
| HOSPITAL | 2 | 0 | CATHOLIC WORKER HOSPITALITY HOUSE, FRANCISCAN HOSPITALLER SISTERS (both arguably *should* be excluded) |
| DIOCESE | 1 | 0 | SF ARCHDIOCESE (should be excluded) |

Everything else (CITY OF 28, ROMAN CATHOLIC BISHOP 23, FOUNDATION 14, COLLEGE 13, SCHOOL 13, ASSOCIATION 8, UNIVERSITY 7, DISTRICT 6, …) is identical either way.

---

## Part 2 — Questions for Ryan (list build)

1. **Folder.** Confirm outputs go directly into `Marketing / 2026 / NOO October2026` (alongside the three originals, which stay untouched). I don't think a raw-archive subfolder is needed — say so if you want one.
2. **Row count.** 42,459 rows vs the ~35k you expected. Confirm these three files (uploaded Oct 2, 6:01 PM PT) are the right pull before I build on them.
3. **DNC matching reality.** No parcel, zip, city, or mailing address exists on any DNC row, so match keys (b) and (c) from the spec are dead and (a) only works when city/zip can be parsed out of free text. Proposed rules — approve or amend:
   - Site street parsed from free text, normalized per the spec, matched against the list's `Site Address`; require the DNC city or zip to match when the DNC row has one.
   - When the DNC row has a house-numbered street but **no city and no zip** (3 rows), match on street alone. Over-suppressing a handful of rows is cheaper than mailing a DNC.
   - Name match only when the DNC name has at least two tokens after stripping trust/parenthetical decoration; exact match against Owner Name / Owner Name2 / Owner1+2 First+Last; plus the city/zip requirement from the spec (which means names without a parsed city never match).
   - The 18 phone/email-only rows are reported as unscrubbable; they're still caught at inbound time by the lead-DNC flag.
4. **Exclusion matching.** Whole-word (token-boundary) matching for every pattern, with three additions to the religious group: ARCHDIOCESE, HOSPITALLER, HOSPITALITY HOUSE. Yes/no, and anything to add or drop (e.g. LLLP, SISTERS OF)?
5. **Owner Name only** for exclusions and signals, per the spec. Owner Name2 is often a near-duplicate; confirm I ignore it except for the DNC name match.
6. **Tenure "today"** = 2026-10-08. ≥11 years means Sale Date on or before 2015-10-08. The profile will show how many rows the title rep's cutoff left just under 11 years.

---

## Part 3 — Tracking build: plan + questions (no code yet)

What exists today (verified in code 2026-10-08):

- Phone attribution is `CAMPAIGN_MAP` in `lib/leads.ts:8` (13 numbers → labels like `MFM-A`, `MFM-B`, `Legacy DM`). An unmapped number gets `source = "Unknown"`, `source_type = "direct_mail"`, a fresh direct-mail drip stamp, and `campaign_id = null`.
- `resolveCampaignId` (`lib/campaigns.ts:23-71`) is a hard-coded if/else on the label: MFM-A/SVG-A → `direct_mail` + `pink-envelope`, MFM-B/SVJ-B → `white-envelope`, Google → `google_ads`. Anything else → null. It then picks the newest `campaigns` row with that channel+variant and `drop_date <= lead.created_at`, preferring a child.
- Email attribution is `config/email-campaigns.json` (6 mailboxes), a build-time import. Pub/Sub notifications for mailboxes in `CAMPAIGN_INBOXES` (`lib/campaignInbox.ts:59`) are diverted to the agent-email stack; unlisted addresses are dropped with a warning.
- `campaigns` has no phone/mailbox column; `channel` is a CHECK constraint (`direct_mail` | `google_ads`); parent/child via `parent_campaign_id`; create via `POST /api/campaigns` or the "+ New Campaign" modal; no PATCH/DELETE (Ryan edits in Studio).
- `leads` is one row per event; a "cluster" is derived at read time by `clusterKey()` (`lib/leads.ts:552`: phone → gmail thread → email). Returning callers inherit `status`, `source`, `source_type`, `drip_campaign_type` from the cluster's most recent inbound row. No `cluster_id`, no `lead_events`, no status history.
- Campaign Performance = `app/api/campaigns/performance/route.ts` (JS over PostgREST reads, dedupes to clusters, drops junk clusters, computes response/offer/close rates) rendered by `components/widgets/CampaignPerformanceTab.tsx`. No paging past 1000 rows.
- DNC: `POST /api/leads/[id]/dnc` sets `is_dnc` + inserts `dnc_list` with only `site_address = property_address`, `owner_name`; DB triggers mirror into `suppression`. SMS STOP and AI auto-DNC set `is_dnc` directly (trigger-only path).
- Migrations: `supabase/migrations/YYYY-MM-DD_name.sql`, idempotent, applied with `node scripts/run-migration.mjs <file>` (Management API, `SUPABASE_PAT`). Importer template: `scripts/import-relationships-agents.mjs` (dry-run by default, `--commit`, `pageAll` past the 1000-row cap).

### 3.1 `mail_records`

**Migration** `supabase/migrations/2026-10-XX_mail_records.sql`:

- `mail_records`: `id uuid pk`, `campaign_id uuid not null references campaigns(id)`, `record_id text not null`, `unique (campaign_id, record_id)`.
- Identity: `parcel_number`, `owner_name`, `owner_name2`, `owner1_first`, `owner1_last`, `owner2_first`, `owner2_last`, `site_address`, `site_city`, `site_zip`, `mail_address`, `mail_city`, `mail_state`, `mail_zip`, `county`.
- Campaign: `arm text check (arm in ('A','B','C','none','seed'))`, `batch int`, `drop_date date`, `arrived_at date`, `is_seed bool not null default false`.
- Tags: `tenure_years numeric`, `tenure_bucket text`, `imp_tercile text`, `year_built_bucket text`, `owner_type text`, `po_box bool`, `managed bool`, `out_of_county bool`, `parcel_count int`, `parcels text`.
- Signals: `estate_language bool`, `family_transfer bool`, `out_of_state bool`, `multi_parcel_personal bool`, `any_signal bool`.
- Source numerics kept typed for reporting: `sale_date date`, `sales_price numeric`, `year_built int`, `assessed_improve_pct numeric`.
- Match keys, precomputed at import with the same normalizer the lead matcher uses: `site_street_norm`, `site_city_norm`, `mail_line_norm`, `owner_surname_norm` (Owner1 Last), `owner_name_norm`.
- `raw jsonb` holding all 43 original columns verbatim (so nothing is lost without 43 more columns).
- Indexes: `(campaign_id, site_street_norm)`, `(campaign_id, owner_surname_norm)`, `(campaign_id, batch)`, `(parcel_number)`.
- `created_at`.

**Importer** `scripts/import-mail-records.mjs --file <mission_control_import.csv> --campaign <uuid> [--commit]`: quote-aware CSV parse, explicit header→column map at the top of the file (fails loudly on an unexpected header), normalizers shared with `lib/` via a small `lib/mailMatch.ts`, upsert on `(campaign_id, record_id)` in 500-row chunks, then reconciliation: rows in file = rows in table for that campaign, and per-arm/per-batch counts must equal the Step 12 reconciliation table (passed in as `--expect <json>`); any mismatch exits non-zero and prints the diff. After import it sets `campaigns.pieces_sent` to the non-seed mailed count.

**Drop dates:** a tiny `scripts/stamp-drop.mjs --campaign <id> --batch N --drop 2026-11-03 [--arrived 2026-11-07]` updates `drop_date`/`arrived_at` for every row in the batch. (A `mail_batches` table is cleaner but adds a join everywhere; stamping the rows matches Ryan's spec.)

### 3.2 Lead → mailed record link

**Migration** (same file or `2026-10-XX_leads_mail_link.sql`): on `leads` add `mail_record_id uuid references mail_records(id) on delete set null`, `mail_match_method text` (`auto_address` | `auto_surname` | `manual` | null), `mail_match_candidates uuid[]` (null when none / one hit). Index `(mail_record_id)`.

**Cluster semantics.** Clusters are derived, so the link lives on rows and is applied cluster-wide, exactly how `haltOutreachForCluster` applies `is_dnc`: linking writes `mail_record_id` to every row sharing the cluster key, and the SMS/voice/email intake routes add `mail_record_id` to the fields a returning caller inherits from the most recent inbound row (`sms/route.ts:155-166`, `voice/route.ts:143-148`). `groupLeads()` in `LeadsTab.tsx:271` exposes the group's link as "any row has it".

**Auto-suggest** runs where `property_address`/`name` get written: after AI triage fills them (in `lib/leads.ts` triage completion) and after any manual `PATCH` of those fields. Only for leads whose `campaign_id` is a campaign that has `mail_records`. Lookup order: (1) normalized street + (city equal or lead city blank) → (2) owner surname + city. Exactly one hit → attach + method; several → store in `mail_match_candidates`; zero → leave unmatched. Never overwrites a `manual` link.

**Manual link** on the lead card (`LeadCard`, `LeadsTab.tsx:1914`): a "🏠 Mailed record" row in the identity block (`:2163-2184`) showing the linked record (owner · site address · arm · batch) or an **Unmatched** / **Candidates (n)** chip in the header badge row (`:2003-2058`). Click → modal (same shell as `EmailComposerModal`, `:2673`) with one search box hitting `GET /api/mail-records/search?campaign=<id>&q=<street or last name>` (ILIKE on the norm columns, 20 results, shows candidates first), pick → `PATCH /api/leads/[id]/mail-record { mail_record_id }` (cluster-wide write), plus Unlink.

**Unmatched list:** a filter chip on the Leads tab, "DM Q4 · unmatched" (source = this campaign's label, no `mail_record_id` in the cluster, not junk), and the same count on the campaign card in Campaign Performance.

### 3.3 Campaign setup

- One `campaigns` row: `name = "Absentee SFR Q4 2026"`, `channel = direct_mail`, `variant = "absentee-q4-2026"`, `drop_date` = first drop, `pieces_sent` = mailed non-seed count (set by the importer), `total_cost`, no parent, no children.
- **Phone:** add `"+1<new number>": "DM-ABS-Q4"` to `CAMPAIGN_MAP` (`lib/leads.ts:8`). That also makes it an owned number. Twilio console: Voice + Messaging webhooks → `/api/leads/voice` and `/api/leads/sms` (same as the MFM lines), and the number must be added to the A2P messaging-service pool or outbound texts from it die silently (`30034`). Add a `SOURCE_BADGE` colour in `LeadsTab.tsx:195`.
- **Resolver:** today `resolveCampaignId` needs a new `else if (s === "DM-ABS-Q4") { channel = "direct_mail"; variant = "absentee-q4-2026" }`. Because the variant filter is part of the query, MFM-A/B leads cannot resolve to this campaign and this label cannot resolve to theirs. Recommended instead: add `campaigns.source_label text` and resolve by `source_label = source` first, falling back to the legacy if/else, so the next campaign is a row, not a code change.
- **Email:** `node scripts/add-email-mailbox.mjs <address> DM-ABS-Q4` writes the JSON entry and registers the Gmail watch; redeploy (build-time import); the address must NOT be added to `CAMPAIGN_INBOXES`. Constraints: the domain must be lrghomes.com / lrghomesbuys.com / lrghomesoffers.com, and it must be a real Workspace mailbox, not an alias (aliases 401 under domain-wide delegation).
- **What falls where after this:** calls/texts to the new number → `DM-ABS-Q4` → this campaign. Emails to the new mailbox → same. The seven ported lines stay `Legacy DM` (resolve null) and MFM lines stay MFM; nothing crosses because resolution is label-driven. One known leak: a caller who previously came in on an MFM or legacy line and now calls the new number **inherits the old source** (cluster rule) and would not attribute here.

### 3.4 Segment reporting

- **Data layer:** one Postgres function `mail_segment_stats(campaign_id uuid, dimension text)` returning `(segment, pieces, responders, calls_per_thousand, cost_per_response)` where pieces = `mail_records` with `is_seed = false` and arm in (A,B,C), responders = distinct `mail_record_id` among non-junk lead rows linked to that campaign, cost per response = `(pieces × total_cost / pieces_sent) / responders`. Dimensions: `arm`, `county`, `batch`, `tenure_bucket`, `imp_tercile`, `year_built_bucket`, `owner_type`, and each signal as its own true/false split. Called via `sb.rpc` from `GET /api/campaigns/[id]/segments?by=<dimension>`. A second function `mail_response_timing(campaign_id)` returns per batch: n, median / p25 / p75 days from `coalesce(arrived_at, drop_date)` to the cluster's first inbound, plus a weekly histogram.
- **Surface:** extend Campaign Performance. Expanding a direct-mail campaign card that has mail records shows a "Segments" panel (dimension pills → table) and a "Timing" table by batch, plus the unmatched-responder count so the denominator caveat is visible. No new tab; no new page.
- Caveat stated on the panel: segment rates count matched responders only; the campaign-level response rate still counts every attributed cluster.

### 3.5 DNC improvement

- Manual path: `POST /api/leads/[id]/dnc` resolves the cluster's `mail_record_id` and writes `parcel_number`, `site_address/city/state/zip`, `mail_address/city/state/zip`, `county`, `owner_name` from the mail record into the `dnc_list` insert; the existing `dnc_list → suppression` trigger carries them through unchanged.
- Every other path (SMS STOP, AI auto-DNC, drip hard stop) only sets `is_dnc`, so the `suppression_sync_from_lead()` trigger is amended in a migration to look up `mail_records` by `new.mail_record_id` and copy the same fields. Un-DNC symmetry unchanged.
- Folded parcels: the mail record's `parcels` list is stored in `suppression.reason` text; the next list scrub matches on mailing address anyway, which all folded parcels share.

### 3.6 Seeds

`is_seed` on `mail_records`; the importer, `pieces_sent`, the segment function, and the Campaign Performance denominator all filter `is_seed = false`. Seeds carry `arm = 'seed'`, `record_id = SEED-<batch>`. Ryan's own test calls/texts keep being marked junk by hand (junk clusters are already excluded from response counts); nothing to build.

### 3.7 `lead_status_history` (optional)

Migration: `lead_status_history (id, lead_id, field, old_value, new_value, changed_at default now(), changed_by)` + an `AFTER UPDATE` trigger on `leads` firing on `status`, `temperature`, `is_dnc`, `is_junk`, `mail_record_id`. `changed_by` comes from `current_setting('app.actor', true)` (routes set it per request; webhooks and the drip engine label themselves), else `'unknown'`. No UI this round; the Sales Coach brief already wants the same table. ~1 migration, zero routes.

### Build order and size (after approval)

1. Migrations: `mail_records` + lead link columns + `campaigns.source_label` + trigger amendment (one file, idempotent). Apply with `run-migration.mjs`.
2. `lib/mailMatch.ts` normalizers + importer + drop-stamp script.
3. `CAMPAIGN_MAP`, badge, resolver, mailbox JSON, redeploy, Twilio config.
4. Lead link: intake inheritance, auto-suggest hook, search + link routes, card UI, unmatched filter.
5. DNC route + trigger.
6. Segment/timing functions + route + Campaign Performance panel.
7. (optional) `lead_status_history`.

### Decisions that are Ryan's

1. Campaign label string (proposed `DM-ABS-Q4`) and the Twilio number: an existing unused line or a new purchase? Do I configure the number's webhooks and A2P pool via the Twilio API, or do you do it in the console?
2. Dedicated email: a new paid Workspace mailbox (which address?), or re-point an idle real mailbox? MFM-A/B mailboxes (`ryansvg@`, `ryansvj@`) would mix any MFM tail into this campaign; `ryansvr@` is in the agent-email inbox set.
3. Resolver: table-driven `campaigns.source_label` (recommended) or just another if/else branch.
4. Returning callers: keep the inherit rule (a prior MFM caller calling the new number stays MFM) or override source when the dialed line is this campaign's number? Recommend override for the DM number only, with the old source kept on the earlier rows.
5. Matching scope: match only mailed rows (A/B/C), or the whole list including `arm = none` and flag "in list but not mailed" separately? Recommend the second; it surfaces mis-attributed responders.
6. Add the mailing address as a third auto-match key (callers often read the address off the envelope)? Recommend yes.
7. Reporting surface: extension of Campaign Performance (recommended) vs a new tab.
8. Drop dates per batch via the stamp script (recommended) vs a UI control.
9. Keep all 43 source columns as `raw jsonb` plus typed columns for what reporting needs (recommended) vs 43 explicit columns.
10. `lead_status_history`: build now, later, or not.
11. Should the standard direct-mail drip cadence (`direct_mail_call` / `direct_mail_sms`) fire for this campaign's new callers as it does for MFM? Default yes unless you say otherwise.

---

## Part 4 — Phase 1 completed 2026-10-08 (Steps 2–4)

Ryan's rulings: any DNC home address OR name that appears in the list is removed (never house number alone); exclusion patterns are whole-word, never inside a person's name; add ARCHDIOCESE / HOSPITALITY HOUSE / HOSPITALLER.

| Step | In | Out | Removed | Ties |
|---|---|---|---|---|
| 2 DNC scrub | 42,459 | 42,450 (`master_absentee_scrubbed.csv`) | 9 (`dnc_removed.csv`: 4 name-only, 3 name+city, 2 site address, 1 mailing address; 8 SCC / 1 SMC) | ✅ |
| 3 Owner-type exclusions | 42,450 | 42,247 (`master_absentee_clean.csv`) | 203 (`excluded_owner_type.csv`; 113 SCC / 56 SMC / 34 SCZ; CHURCH 72, CITY OF 28, ROMAN CATHOLIC BISHOP 22, BANK 21 …) | ✅ |

Surname guard in Step 3: a one-word pattern equal to Owner1/Owner2 Last Name with a real given name (seen 3+ times as a first name in the file, not a stopword) is kept — kept 6 rows: William & Margaret Church, Mark Church, Scott Church, Lisa Temple, Christopher & Staci Temple, Kathleen Temple.

**Data findings that change later steps**
- `Mail Address` drops the unit; `Full Mail Address` keeps it (`231 Market Pl # 290`). 2,500 rows (5.9%) carry a unit. Every mailing-address operation from here on (managed tag, dedupe key, DNC compare, mail-house file) uses `Full Mail Address`.
- San Mateo `Assessed Improve Percent` is 50 on 4,746 of 8,840 rows (54%), so q25 = q50 = q75 = 50 and within-county terciles are degenerate there; Santa Clara 1,043 rows at 50, Santa Cruz 202. Tercile rule for ties needs Ryan's call (proposed: rank with ties broken by APN so terciles are equal-sized, and report the 50-lump separately).
- Every Sale Date parses; minimum tenure 11.77 years (title rep's cutoff held).

Step 4 profile (clean file): tenure ≥15 35,823 · ≥20 26,264 · ≥25 17,524 · ≥30 9,784 · ≥35 4,542. Owner type: person 33,365 · trust 7,974 · entity 908. Blank Owner1 First Name 5.6% (SMC 11.4%). Rough Arm B (undeduped): estate 450 · family_transfer(Seller1) 2,777 · prior-seller variant 381 · out_of_state 3,284 · multi_parcel_personal 4,627 · any 10,328 (778 with 2+). Blank Sales Price 43% (SMC 21.9%). PO box 10.8% (SCZ 19.3%). Managed 4.0%.

Phase 2 (zip table) next, on Ryan's go.
