Status: LIVE 2026-10-16 (evening) — migration applied, merged to main, Halleck report + ITI invoice 243496 filed by the watcher; next live tests = South Bay termite PDF, Juan's exemption form / signed proofs, 💸 Paid after the wire, Quito awaiting_payment cycle

You are building a self-contained change to the Inbox Agent (the ryan@lrghomes.com Gmail watcher) in this Next.js repo. Work on a new branch `inbox-vendor-filing-tapinspect` off `main`, commit in small conventional commits, and push the branch with `git push -u origin inbox-vendor-filing-tapinspect`. Do NOT open a PR, do NOT touch `main`, never `git add -A`. You have no access to the production Supabase, Gmail, Drive or Telegram: everything you ship must be covered by vitest unit tests with fixtures (`npm test` = `vitest run`) and `npx tsc --noEmit` must pass. Live replays and the migration will be run by the operator on the Mac mini afterwards, from your HANDOFF section.

First, save this entire brief verbatim as `briefs/BRIEF_INBOX_VENDOR_FILING_TAPINSPECT_2026-10-16.md` (add a status line at the top: `Status: built + reviewed 2026-10-16 (evening) — awaiting migration + push to main, then live replays`) and commit it. Then read, in this order, before writing code: `briefs/INBOX_FILING_RULES.md`, `briefs/BRIEF_INBOX_LINK_FETCH_2026-10-12.md`, `briefs/BRIEF_INBOX_MEDIA_DELIVERY_2026-10-15.md`, `scripts/inbox-agent/{env,llm,filing,drive,index}.mjs`, `scripts/inbox-agent/fetch/{providers,index,browser,docusign,f8}.mjs`, `tests/inbox-fetch.unit.test.ts`, `tests/inbox-media-fetch.unit.test.ts`, `supabase/migrations/2026-10-12_inbox_fetches.sql`, `supabase/migrations/2026-09-24_inbox_agent.sql`. Match the existing style: pure helpers in small modules that both the worker and tests import, deterministic rules in `filing.mjs`, `inbox_settings` key/value for config via `getSetting/setSetting` in `env.mjs`, Telegram callback conventions already in `index.mjs` (`ix:` namespace, 64-byte callback data).

# Background (decided with Ryan 2026-10-16)

The filing convention v2 only files transaction documents into `Properties/<address>/<subfolder>`; invoices are deliberately ignored on deal threads (Ryan: "a total waste of time"). Two gaps surfaced:

1. **ITI Direct Mail** (the mail house for Ryan's direct-mail campaigns; Juan Muniz `juan@letterprinting.net`, also `alan@letterprinting.net`) sends invoices Ryan DOES want kept, plus proofs. Both ITI invoices for the current campaign were classified correctly (`doc_type: invoice`, property null) and then dropped by the whitelist. Ryan wants a SURGICAL carve-out: ITI only, not invoices in general.
2. **HomeSentry Inspections** delivers home-inspection reports as a link to `https://app.tapinspect.com/shares/<uuid>` with no PDF attached. The classifier already extracts the link into `classification.document_links` and resolves the property, but `detectProvider` returns null for tapinspect so nothing is queued in `inbox_fetches`. The Halleck report (5764 Halleck Dr) is sitting un-filed; Quito (2116 Quito Rd) arrived the same way on 10/16.

South Bay Termite (`southbaytermite@yahoo.com`) needs no fetcher: after payment they email the report as a plain PDF attachment (e.g. subject `Termite Report & Receipt | 674 Kirkland Dr, SUNNYVALE`, attachment `Report 674.pdf`, receipt on the last page). Only a small guard is needed (Part C).

# Part A — ITI vendor filing (campaign folder, not a property folder)

## A1. Vendor rules in inbox_settings
New `inbox_settings` key `vendors` → `{ rules: [ { id: "iti", name: "ITI Direct Mail", senders: ["juan@letterprinting.net", "alan@letterprinting.net"], relays: [ { sender: "docs@email.pandadoc.net", subject_re: "iti Direct Mail|Proof.*order #" } ], doc_types: ["invoice", "proof", "quote", "tax_form"], campaign_id: "5b71ff54-14f9-4c83-a14d-8d1eed6325f2", subfolder: "3 - MAIL HOUSE" } ] }`. Seed it in the migration (upsert on key). A pure helper `matchVendor(msg, vendors)` returns the rule or null: sender exact match (case-insensitive) on `senders`, or a relay sender whose subject matches `subject_re`. Only a vendor match unlocks the vendor doc types; for every other sender the whitelist behaviour is UNCHANGED (add a regression test: an invoice from `draws@kiavi.com` or a random sender is still `ignored`).

## A2. Campaign → Drive folder
Migration `supabase/migrations/2026-10-16_campaign_drive_folder.sql`: `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS drive_folder_id text;` with a COMMENT, and seed `UPDATE campaigns SET drive_folder_id = '14qk007vZ5iHMPLU3lAjiOB-_o_Go0N--' WHERE id = '5b71ff54-14f9-4c83-a14d-8d1eed6325f2';` (the NOO Q4 2026 parent campaign; the folder is `My Hard Drive / Marketing / 2026 / NOO October2026`). Resolution order for where an ITI document goes: (1) the vendor rule's pinned `campaign_id` → that campaign's `drive_folder_id`; (2) otherwise, if exactly one campaign has a `drive_folder_id` and is not archived/finished → that one; (3) otherwise a ❓ card (reuse the existing "property unknown" card shape: ✅ use guess / ✏️ Tell me where / ⏭ Skip) and nothing is filed. Inside the campaign folder, the destination is the child folder whose name starts with the rule's `subfolder` (`3 - MAIL HOUSE`; the real folder is `3 - MAIL HOUSE (quote, invoice, proofs)`, id `1xBrFye93LmOZ81s2UHsJ6vS1LUVupXrI`); create it if missing. Extend `drive.mjs` as needed to resolve a folder by id + child-by-prefix (the DWD Drive client already exists there). Add `drive_folder_id` to whatever campaign TypeScript type/select lists exist (grep `total_cost` in `app/api/campaigns/`), without changing UI.

## A3. Doc types and names
Add `proof` and `tax_form` to the classifier doc_type list in `llm.mjs` (keep the prompt note terse: proof = a print proof / mockup to approve; tax_form = a sales-tax exemption certificate such as CDTFA-230 / Reg 1541.5). In `filing.mjs refineDocType`: filename `/proof/i` → `proof`; `/exempt|CDTFA|230-?P|1541/i` → `tax_form`. Vendor filenames (deterministic, in `filing.mjs`):
- Invoice: `ITI invoice <number> - <YYYY-MM-DD> - $<total>.pdf`. Number = leading digits of the attachment filename (ITI names them `243496_RyanLarocca_LRG-Homes--LLC_2026-10-15-13-11-35.pdf`). Total = parse `Total :$10,385.57` from the email body (ITI always puts `Subtotal / Shipping Charges / Discount / Tax / Total` lines in the body); also parse Subtotal, Discount, Tax. If no total is found, omit the `- $…` part. Date = email received date (PT).
- Proof: ONLY the PandaDoc signed copy is filed (Ryan: "only store proofs that have been signed and accepted"). Match: relay sender `docs@email.pandadoc.net`, subject `/Signed copy of "(.+)"/`, PDF attached. Name `ITI proof <document title> - signed - <YYYY-MM-DD>.pdf` (e.g. `ITI proof RE-Proof3 for order #240069 - signed - 2026-04-30.pdf`, sanitize `#`/quotes via `sanitizeFilename`). Unsigned PandaDoc "sent you Proof … via PandaDoc" emails and proof PDFs Juan attaches directly are NOT filed (status `ignored`, reason "unsigned proof") — their needs-reply handling stays as today.
- Tax form: `ITI tax exemption form - <YYYY-MM-DD>[ - signed].pdf` (` - signed` when the classifier says signed or the filename says signed/executed).
- Quote: `ITI quote - <YYYY-MM-DD>.pdf`.

## A4. Revised / disputed invoices
ITI issues a NEW invoice number on every revision (243481 → 243496 on this order). Rule: every version is kept, nothing overwritten. When a new ITI invoice is filed into a campaign folder, every existing file in that folder matching `/^ITI invoice /` that does not already end in ` PAID.pdf` or ` SUPERSEDED.pdf` is renamed to append ` SUPERSEDED` before the extension. Store the parsed amounts (`{subtotal, discount, tax, total, invoice_no}`) on the `inbox_files` row (check its columns; add a jsonb `meta` column in the migration if there is no suitable one). The confirmation card shows the diff against the most recent previous invoice in the same folder: one line each for Subtotal, Discount, Tax, Total with old → new, plus "setup/other line changes: see PDF". Card buttons: `↩️ Undo` (existing behaviour) and `💸 Paid`. `Paid` → rename the file to append ` PAID`, set `campaigns.total_cost = total` on the resolved campaign (the parent) and edit the card to say so. Make the rename/mark helpers pure and unit-tested; the Drive calls go through `drive.mjs`.

## A5. Cards and logging
Vendor filings post the same one-card-per-email confirmation as property filings, with the campaign name instead of a property. Log line format like the existing ones. `inbox_files.status = filed` with the Drive path `Marketing/2026/NOO October2026/3 - MAIL HOUSE (…)/<name>`.

# Part B — HomeSentry / tapinspect report fetcher

## B1. Provider
`fetch/providers.mjs detectProvider`: host `app.tapinspect.com`, path `/shares/<uuid>` → `"tapinspect"`, `providerKind` = `"document"`. Everything else on tapinspect.com is null. Update the `Provider` typedef and tests.

## B2. What the share page looks like (probed headless 2026-10-16, public, no login)
Title `5764 Halleck Dr, San Jose, CA 95123 - Tap Inspect`. Body text: company header, then instructions: "Please click on View Report to see your inspection results. If you have not signed pre-inspection or made payment results will not be viewable. Click on Agreements and Invoice Button. … If you choose to download a PDF version of report, scroll to the bottom at left side of report and you will see a download report button there. Or, if viewing on a mobile device, tap the 3 dots at upper right and you will see download option there." Then sections: `Reports` → link/button `Home Inspection Report`; `Attachments` → `Invoice 11275718`, `New Ca Agreement — Signed on October 13, 2026 … by Ryan LaRocca`, `Home Maintenance Manual ( Download )`. NOTE the gate sentence is static instructions and is present even when the report IS viewable — do not use it as the gate signal. Gate detection = after clicking `Home Inspection Report`: the report view fails to render / shows a message about payment or agreement / no download control appears within the timeout → treat as not yet viewable.

## B3. Fetcher `fetch/tapinspect.mjs`
Mirror `f8.mjs`/`docusign.mjs` structure and the shared `browser.mjs` (persistent profile, download handling, screenshot on failure into `inbox_fetches.screenshot`). Steps: open share URL → click the `Home Inspection Report` entry under `Reports` → wait for the report view → find the download control (bottom-left "download report" button; fallback: the ⋮ menu top-right → Download) → save the PDF. Keep every selector/text match in a small `SELECTORS` object at the top so drift fixes are one-line. Only the report is fetched: never the Invoice attachment, never the agreement (not whitelisted), never the maintenance manual. Hand the PDF to the normal document filing (`fileDocuments` path used by DocuSign), doc_type `inspection`, property from the email classification (tapinspect subjects carry the full address) cross-checked with the PDF first page as usual. Filename: `<property> Inspection Report <YYYY-MM-DD> (HomeSentry).pdf` — dated so an updated report files as a new version (the sha dedupe already skips an unchanged PDF).

## B4. `awaiting_payment` state (the watcher never pays anything)
HomeSentry's flow is invoice → signed agreement → report viewable. When the fetch runs and the report is not viewable (B2 gate), set `inbox_fetches.status = 'awaiting_payment'`, `error = 'report not viewable yet (payment/agreement pending)'`, `next_try_at = now + 24h`, no extra card (the email already produces a needs-reply loop "sign agreement / pay", keep that). Wake rules, in `fetch/index.mjs` as pure helpers + wired in `index.mjs`: (a) a new email from `inspections@tapinspect.com` whose body/links carry the same share uuid, or whose subject matches `/payment|updated|results/i` for the same property → requeue the parked row (status `queued`, attempts 0, next_try_at null); (b) a `fetch` reply on the card → requeue (existing path); (c) daily retry while `awaiting_payment` via `next_try_at`, up to 14 days, then `expired` with one card saying the report was never released. Document the status in the migration comment (`inbox_fetches.status` is free text; add the new value to the comment line via a `COMMENT ON COLUMN`).

## B5. Same URL twice
`inbox_fetches_url_once` is a unique index on `url_sha256`, and HomeSentry reuses the SAME share URL for the "results have been updated" email. In `enqueueFetches`, when the URL already exists: if its status is `done`, `awaiting_payment`, `failed` or `expired` and the provider is `tapinspect` → requeue that row (do not insert); if `queued`/`running` → leave it. Unit-test this with the Halleck sequence below.

# Part C — South Bay Termite guard (no fetcher)
In `refineDocType`: when the subject matches `/termite|\bWDO\b/i` and the filename does NOT match `/invoice|receipt/i`, return `inspection` even if the model said `invoice` or `other` (their attachment is a bare `Report 674.pdf` with the receipt on the last page). Add a unit test with the Kirkland fixture (subject `Termite Report & Receipt | 674 Kirkland Dr, SUNNYVALE`, attachment `Report 674.pdf`, model doc_type `invoice`) expecting `inspection` → whitelisted → `Properties/<property>/Inspections`. Also a forwarded variant from `amanda@bakshirealestate.com` with subject prefixed `Fwd: Termite Report & Invoice | …`.

# Tests (vitest, fixtures only)
- providers: tapinspect share URL → `tapinspect`; other tapinspect paths → null; existing DocuSign/f8 cases unchanged.
- vendor matching: Juan direct, Alan, PandaDoc relay with ITI subject (match), PandaDoc relay with another vendor's subject (no match), Kiavi invoice (no match, still ignored).
- naming: invoice (with and without total in body), signed proof, tax form, quote; `sanitizeFilename` applied.
- supersede: folder listing with `ITI invoice 243481 …pdf`, `ITI invoice 2401xx … PAID.pdf`, `…SUPERSEDED.pdf` → exactly the first is renamed; diff lines computed from stored amounts.
- awaiting_payment transitions and wake rules; daily retry cutoff at 14 days; same-URL requeue matrix.
- South Bay guard.
Run `npm test` and `npx tsc --noEmit`; both must be green before you push.

# Deliverables
1. Branch `inbox-vendor-filing-tapinspect` pushed, with the brief file, code, tests, and the migration(s).
2. Append a `## HANDOFF (for the operator on the Mac mini)` section to the brief with: the exact migration file(s) to apply; the exact dry-run and live replay commands using `node scripts/inbox-agent/index.mjs --dry-run --message=<gmail id>` and the fetch CLI for these Gmail ids — ITI invoice 243481 `1a13c59abc37044f`, ITI invoice 243496 `1a14686438fae4d0`, PandaDoc signed proof sample `19de0808960889dc`, HomeSentry Halleck first results `1a14056ab449524c`, Halleck results updated `1a146754b76d30a8`, Halleck payment thanks `1a14674c084ab8c7`, South Bay Kirkland `198ec7d2d2920eab`; the expected outcome of each; the Drive folders involved (`3 - MAIL HOUSE` id `1xBrFye93LmOZ81s2UHsJ6vS1LUVupXrI`, Halleck `Inspections` id `1deox4lOmxaEWan6nnXbfL8GQplnP0oIG`, currently empty); and anything you could not verify without live access.
3. In your final message, summarise what changed file by file, the test count, and any judgement calls.

# Don'ts
No new npm dependencies. Do not change behaviour for non-vendor senders or any property filing path beyond Parts B/C. Do not touch anything about `93 Ridgeview`. Do not run migrations or hit any live service. Do not refactor unrelated code.

---

## HANDOFF (for the operator on the Mac mini)

Built on branch `inbox-vendor-filing-tapinspect` (cloud session, 2026-10-16). `npm test` = 488 passing (33 new across `tests/inbox-vendor-filing.unit.test.ts` + `tests/inbox-tapinspect.unit.test.ts`), `npx tsc --noEmit` clean. Nothing live was touched: no migration run, no Gmail / Drive / Supabase / Telegram / tapinspect calls.

### 1. Migration (apply first, once)

```
node scripts/run-migration.mjs supabase/migrations/2026-10-16_campaign_drive_folder.sql
```

Idempotent. It adds `campaigns.drive_folder_id` (seeded `14qk007vZ5iHMPLU3lAjiOB-_o_Go0N--` on `5b71ff54-14f9-4c83-a14d-8d1eed6325f2`), upserts `inbox_settings.vendors` (the ITI rule), adds `inbox_files.meta jsonb`, and rewrites the `inbox_fetches.status` column comment. Check: `select id, name, drive_folder_id from campaigns where drive_folder_id is not null;` → one row (NOO Q4 2026). The worker falls back to the same ITI rule from `DEFAULT_VENDORS` in `scripts/inbox-agent/vendors.mjs` if the settings row is missing, but `campaigns.drive_folder_id` must exist or every ITI document gets a ❓ card.

### 2. Dry runs (no DB writes, no Drive upload, no Telegram; link fetches still open Chrome and write to `/tmp/inbox-fetch/<job>/`)

| Gmail id | What | Command | Expected log lines |
|---|---|---|---|
| `1a13c59abc37044f` | ITI invoice 243481 | `node scripts/inbox-agent/index.mjs --dry-run --message=1a13c59abc37044f` | `vendor ITI Direct Mail: filed 243481_… → Marketing/2026/NOO October2026/3 - MAIL HOUSE (quote, invoice, proofs)/ITI invoice 243481 - <date> - $<total>.pdf`; a dry-run Telegram card `🗂 Filed 1 document from ITI Direct Mail` with `📣 NOO Q4 2026`, buttons `↩️ Undo` + `💸 Paid`. If the folder already holds an unpaid `ITI invoice …` file you will also see `would rename "…" → "… SUPERSEDED.pdf"`. |
| `1a14686438fae4d0` | ITI invoice 243496 (the revision) | `node scripts/inbox-agent/index.mjs --dry-run --message=1a14686438fae4d0` | Same shape, name `ITI invoice 243496 - 2026-10-15 - $10,385.57.pdf` (if the body carries `Total :$10,385.57`); diff lines only once 243481 is live-filed (they come from `inbox_files.meta` of the previous invoice in the same folder). |
| `19de0808960889dc` | PandaDoc signed proof sample | `node scripts/inbox-agent/index.mjs --dry-run --message=19de0808960889dc` | `vendor ITI Direct Mail: filed RE-Proof3 … → …/3 - MAIL HOUSE (…)/ITI proof RE-Proof3 for order #240069 - signed - 2026-04-30.pdf`. If the classifier gives this email a system kind, the vendor filing still runs (it is wired before the automated-return). An unsigned "sent you Proof …" email logs `ignored (unsigned proof)` instead. |
| `1a14056ab449524c` | HomeSentry Halleck, first results | `node scripts/inbox-agent/index.mjs --dry-run --message=1a14056ab449524c` | `fetch dry-1a14056ab449524c: HomeSentry (Tap Inspect) attempt 1 …` then either `awaiting_payment (try 1/14)` (report still gated) or `[fetch] tapinspect: share → report → download(button) → <file>.pdf` and a would-file line `Properties/5764 Halleck Dr/Inspections/5764 Halleck Dr Inspection Report 2026-10-13 (HomeSentry).pdf` (date = the email's PT date). Screenshots in `/tmp/inbox-fetch/dry-1a14056ab449524c/`. |
| `1a146754b76d30a8` | Halleck results updated (same share URL) | `node scripts/inbox-agent/index.mjs --dry-run --message=1a146754b76d30a8` | Dry run fetches inline (same as above, dated 2026-10-16). Live, this email requeues the existing row instead of inserting (`fetch requeued: tapinspect · was <status>`). |
| `1a14674c084ab8c7` | Halleck payment thanks | `node scripts/inbox-agent/index.mjs --dry-run --message=1a14674c084ab8c7` | No link to fetch; if a Halleck row is parked you see `fetch <id>: would requeue (HomeSentry email “Thank you …”)`. Otherwise nothing fetch-related. |
| `198ec7d2d2920eab` | South Bay Kirkland termite report | `node scripts/inbox-agent/index.mjs --dry-run --message=198ec7d2d2920eab` | `Report 674.pdf` refined to `inspection` → would file `Properties/2025/674 Kirkland Dr/Inspections/Report 674.pdf` (year-bucket property folders are part of the candidate list, so the closed deal's folder matches; a ❓ "New property?" card means the PDF's first page named a different property — the existing ask path, not new). |

Fetch CLI (no DB at all), useful to probe the gate first:

```
node scripts/inbox-agent/fetch/cli.mjs --url "https://app.tapinspect.com/shares/<uuid from 1a14056ab449524c>" --out /tmp/halleck-report
```
Expected: `provider tapinspect`, then either `FAILED: report not viewable yet (payment/agreement pending) (needs: payment)` with the last screenshot path, or `done: 1 file(s) · steps share → report → download(button)` and the PDF in `/tmp/halleck-report/`. Add `--headed` to watch it.

### 3. Live replays (in this order)

```
node scripts/inbox-agent/index.mjs --message=1a13c59abc37044f      # 243481 → filed, card with Undo + Paid
node scripts/inbox-agent/index.mjs --message=1a14686438fae4d0      # 243496 → filed; 243481 renamed "… SUPERSEDED.pdf"; card shows the Subtotal/Discount/Tax/Total diff
node scripts/inbox-agent/index.mjs --message=19de0808960889dc      # signed proof → filed
node scripts/inbox-agent/index.mjs --message=1a14056ab449524c      # queues the Halleck fetch (status queued)
node scripts/inbox-agent/index.mjs                                 # the pass runs the fetch: done + filed, or awaiting_payment (next_try_at = +24 h, no card)
node scripts/inbox-agent/index.mjs --message=1a146754b76d30a8      # same URL → the row is requeued (attempts 0) and the next pass fetches again
node scripts/inbox-agent/index.mjs --message=198ec7d2d2920eab      # Kirkland → Inspections
```
Note `--message=<id>` re-runs an email even if `inbox_messages` already has it, so the ITI rows from the earlier (ignored) runs get a second `inbox_files` row; the sha dedupe only trips once a copy is actually `filed`. Tapping 💸 Paid on the 243496 card → next pass renames the file `… PAID.pdf`, sets `campaigns.total_cost = 10385.57` on NOO Q4 2026 and rewrites the card.

### 4. Drive folders involved

- Campaign folder `14qk007vZ5iHMPLU3lAjiOB-_o_Go0N--` (My Hard Drive / Marketing / 2026 / NOO October2026) — must be visible to `ryan@lrghomes.com` (it is under the shared Marketing root). The agent reads it by id, never by path.
- `3 - MAIL HOUSE (quote, invoice, proofs)` id `1xBrFye93LmOZ81s2UHsJ6vS1LUVupXrI` — matched by the prefix `3 - MAIL HOUSE`; only created (bare, as `3 - MAIL HOUSE`) if no child starts with that prefix.
- Halleck `Inspections` id `1deox4lOmxaEWan6nnXbfL8GQplnP0oIG` (currently empty) — resolved by the normal `Properties/5764 Halleck Dr/Inspections` path, not by id.
- `inbox_files.final_folder` for vendor files is the walked path, e.g. `Marketing/2026/NOO October2026/3 - MAIL HOUSE (quote, invoice, proofs)` (the walk stops at the shared Marketing root; if that root is not cached in `inbox_settings.drive.extra_roots` the path starts further up, e.g. `My Hard Drive/Marketing/…` — cosmetic).

### 5. Not verifiable from the cloud session

- The tapinspect report view itself: whether the report opens in the same tab or a new one (both handled), whether the download control is a button, a link to a `.pdf` URL (fetched in-session) or the ⋮ menu, and what the gated view says. The `SELECTORS` object at the top of `scripts/inbox-agent/fetch/tapinspect.mjs` is the one-line fix point; screenshots land in `/tmp/inbox-fetch/<job>/` (and `<job>-view/` when the report opened in a new tab).
- The exact ITI body text (the parser expects `Subtotal / Shipping Charges / Discount / Tax / Total` on their own lines, `Label :$1,234.56`, `-$`/`($…)` for negatives). If the total is missing from the name, check `inbox_files.meta` for what was parsed.
- Whether the DWD service account (as `ryan@lrghomes.com`) can see and rename files inside the campaign folder; a `⚠️ Couldn't file …` card names the reason.
- The campaigns table has no archived/finished column: resolution rule (2) treats a campaign as current when its `drop_date` is null, in the future, or within 180 days (`CAMPAIGN_CURRENT_DAYS`). ITI is pinned to NOO Q4 2026 anyway.
- `classification.property.label` for the HomeSentry emails (the wake rule falls back to the address in the subject).


## Live verification on the Mac mini (2026-10-16, before the push)

- `fetch/cli.mjs` against the Halleck share URL: first run reached the report but "Download Report" is a **dropdown** (Download Full Report / Download Report Summary Only) → no file. Fixed (`SELECTORS.downloadMenuItem`, flow picks the full report). Second run: `share → report → download(button) → full-report`, `Home_Inspection_Report.pdf`, 9,333,161 bytes, 98 pages.
- `--dry-run --message=1a14056ab449524c` (Halleck first results): classifies `automated · 5764 Halleck Dr`, fetches inline, would file `Properties/5764 Halleck Dr/Inspections/5764 Halleck Dr Inspection Report 2026-10-15 (HomeSentry).pdf`, card with ↩️ Undo.
- `--dry-run --message=198ec7d2d2920eab` (South Bay Kirkland): the email classifies as `automated` with no ask, which hit the system-email early return **before** attachment filing — the Halleck termite PDF would have been dropped the same way. Fixed in `handleMessage`: a system-looking email still files whitelisted documents (nothing else runs). Re-run → `Report 674.pdf` refined to `inspection`, ❓ "New property?" card for 674 Kirkland Dr (closed 2025 deal, no folder under Properties/) with best guess `Properties/674 Kirkland Dr/Inspections/` — the Halleck folder exists, so the live one files directly.
- Independent code review (subagent) findings applied: proof / tax-form filename rules removed from `refineDocType` (they misrouted "Exempt Seller Disclosure" / "Insurance Proof" on deal threads; `vendorDocType` keeps them); tapinspect refuses to hunt for a download control while the share page is still showing and `fetchHrefPdf` runs the click allowlist + a forbidden-href check; `applyPaidRequests` returns in dry runs; 💸 Paid refuses a SUPERSEDED invoice; the webhook's `enqueueFetch` requeues a done / parked / failed / expired tapinspect row on `fetch`; vendor attachments ignore Haiku's `relevant:false`; a "share page is gone" failure is not treated as still parked.
- Not fixed (noted): a later HomeSentry email carrying the same share URL re-fetches a `done` job (sha dedupe skips the file; a card may still post). `tests/offer-contract.unit.test.ts` fails locally only because `pdf-lib` is not installed in the Mac mini's `node_modules` (Vercel has it) — unrelated.
- Migration `2026-10-16_campaign_drive_folder.sql` and the push are classifier-blocked from the auto-mode bridge session; they run after Ryan flips the session mode.
