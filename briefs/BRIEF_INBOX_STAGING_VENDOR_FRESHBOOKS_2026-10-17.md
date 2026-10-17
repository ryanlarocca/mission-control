Status: built + reviewed 2026-10-17 — awaiting migration + merge to main + backfill

You are building a self-contained change to the Inbox Agent (the ryan@lrghomes.com Gmail watcher) in this Next.js repo. Work on a new branch `inbox-staging-vendor` off `main`, commit in small conventional commits, and push the branch with `git push -u origin inbox-staging-vendor`. Do NOT open a PR, do NOT touch `main`, never `git add -A`. You have no access to the production Supabase, Gmail, Drive, Telegram or the open internet: everything you ship must be covered by vitest unit tests with fixtures (`npm test` = `vitest run`, currently 520 passing) and `npx tsc --noEmit` must pass. The migration, the live fetches and the backfill will be run by the operator on the Mac mini afterwards, from your HANDOFF section.

First, save this entire brief verbatim as `briefs/BRIEF_INBOX_STAGING_VENDOR_FRESHBOOKS_2026-10-17.md` (replace the status line at the top with `Status: built + reviewed 2026-10-17 — awaiting migration + merge to main + backfill`) and commit it. Then read, in this order, before writing code: `briefs/BRIEF_INBOX_VENDOR_FILING_TAPINSPECT_2026-10-16.md` (the ITI vendor carve-out + the tapinspect fetcher — this build is the same two patterns applied to a staging company), `briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md` (Part C: FreshBooks "$0.00" is already a completion event), `scripts/inbox-agent/{vendors,filing,llm,drive,loops,index}.mjs`, `scripts/inbox-agent/fetch/{providers,index,browser,tapinspect}.mjs`, `lib/inboxAgent.ts` (the `ix:vp` Paid callback), `tests/inbox-vendor-filing.unit.test.ts`, `tests/inbox-tapinspect.unit.test.ts`, `supabase/migrations/2026-10-16_campaign_drive_folder.sql` (how `inbox_settings.vendors` is seeded). Match the existing style: pure helpers in small modules that both the worker and tests import; Drive calls only in `drive.mjs`; browser flows in `fetch/<provider>.mjs` with a click allowlist and screenshots; thin call sites in `index.mjs`.

# Background (decided with Ryan 2026-10-17)

Ryan: "The one thing I do like to keep is staging contracts, just off of what happened at Ridgeview. It's always good to have those on file." At 93 Ridgeview the staging invoice became a dispute with the listing agent and escrow asked for the agreement; nothing was on file. The filing convention v2 deliberately ignores invoices on deal threads, and ITI Direct Mail is the only vendor carve-out so far (`inbox_settings.vendors`, campaign folder). Staging gets the same surgical treatment, but into the PROPERTY folder.

**StyleMe Home Staging, LLC** (Kowi Chandra, `stylemestaging@gmail.com`, San Jose) bills through **FreshBooks**. Everything arrives from `mail@fb0N.freshbooks.com` (N varies: fb02, fb05 seen) with NO attachment — only a client link:
- Proposal: subject `StyleMe Home Staging, LLC sent you a proposal (SS01174)`, body link `https://my.freshbooks.com/#/link/estimate/<jwt>?companyName=Kowi&entityName=proposal&estimateNumber=SS01174&ownerEmail=stylemestaging%40gmail.com&type=primary` (gmail `1a1273d89af371d2`, 2026-10-10; earlier `1a103e1371adb8cc` SS01168 2026-10-03 for Halleck).
- Invoice: subject `StyleMe Home Staging, LLC sent you an invoice (080223VA)`, body link `https://my.freshbooks.com/#/link/<jwt>?companyName=Kowi&invoiceNumber=080223VA&ownerEmail=stylemestaging%40gmail.com&type=primary` (gmail `1a14ab5d4cc45c46`, 2026-10-17, $3,253.75, Quito; earlier `1a1054b98ffa3062` 080223UP $2,985 2026-10-04, Halleck).
- Comments: `Kowi Chandra commented on invoice 080223UP ($2,985.00)` / `($0.00)` — the `$0.00` one says "Thank you for your payment" and is ALREADY a completion event in `loops.mjs completionEvent` (kind paid, invoice number). Comments carry no document link worth fetching.
- FreshBooks sends the client NO email when a proposal is accepted/signed.

The operator opened both links in headless Chrome (channel "chrome", no login, no persistent profile): the page renders client-side (hash route), shows the document with buttons **Print**, **Download PDF**, View Comments, Send, View History, "Create an account…", "Save this Proposal"; the proposal page also shows a status line ("Invoiced — Kowi Chandra created an invoice for this proposal."), the invoice page "Outstanding $3,253.75 is due on Oct 17, 2026." The page text contains the property: proposal `Prepared For Ryan LaRocca 2116 Quito Rd, San Jose, CA 95130`, invoice `Billed To Ryan LaRocca 2116 Quito Rd, San Jose, CA 95130` and `Description … 3BR/2BA = 2116 Quito Rd, San Jose, CA 95130 Staged area: …`. The jwt in the link carries an `exp` about a year out.

**XO Staging** (Ridgeview, June 2026) bills through QuickBooks (`quickbooks@notification.intuit.com`, "Invoice from XO Staging", View and pay link). NOT in this build — leave a clean seam (provider table + vendor rule) so it is a second rule + second provider later.

# Part A — `Staging` becomes a standard property subfolder

- `filing.mjs PROPERTY_SUBFOLDERS` gains `"Staging"` (after `Construction`, before `Photos`). Wherever the standard set is created for a new property (`postAskCard` "Create Properties/<addr>/ with the standard subfolders", `propertyFolderFor`, backfill), `Staging` is created too; for an EXISTING property folder it is created on first use (`resolvePath`/`childFolderByPrefix` with `create`), never pre-emptively for every property.
- `subfolderFor` / `destinationFor`: new doc types `staging_proposal` and `staging_invoice` → `Staging`. Whitelist (`llm.mjs WHITELIST`) is NOT widened for everybody: these two types only reach filing through the vendor rule (Part B), exactly like ITI's `invoice` / `proof`. Add a regression test: a `staging_invoice`-looking PDF from a random sender is still `ignored`.
- Names (deterministic, `filing.mjs` or `vendors.mjs`, tested): `StyleMe proposal SS01174 - 2026-10-10.pdf`, `StyleMe invoice 080223VA - 2026-10-17 - $3,253.75.pdf`; a paid invoice is renamed with ` PAID` before the extension (reuse `paidName`). Number from the subject's parentheses or the link's `estimateNumber`/`invoiceNumber` query param; amount from the subject/body (`for $3,253.75`) or the fetched page text (`Amount Due (USD) $3,253.75`); date = email received date (PT). Vendor display name comes from the rule (`name_short: "StyleMe"`).

# Part B — StyleMe vendor rule (property destination)

- `inbox_settings.vendors.rules` gains:
  `{ id: "styleme", name: "StyleMe Home Staging", name_short: "StyleMe", senders: [], relays: [{ sender_re: "@fb\\d*\\.freshbooks\\.com$", subject_re: "^StyleMe Home Staging" }], doc_types: ["staging_proposal", "staging_invoice"], destination: "property", subfolder: "Staging" }`
  Seed it in a new migration `supabase/migrations/2026-10-17_vendor_styleme.sql` as an UPSERT that APPENDS to the existing `vendors.rules` array (jsonb — do not clobber the ITI rule; `jsonb_set` / `||` with a guard so re-running does not duplicate). `DEFAULT_VENDORS` in `vendors.mjs` mirrors it.
- `matchVendor`: relays may use `sender_re` (regex on the sender) in addition to the existing exact `sender`; existing ITI behaviour unchanged (tests).
- `vendorDocType`: for a `destination: "property"` rule, the doc type comes from the FreshBooks subject/link: `sent you a proposal` or `entityName=proposal` → `staging_proposal`; `sent you an invoice` or `invoiceNumber=` → `staging_invoice`; the comment emails → null (not a document). Keep ITI's mapping as is.
- Destination resolution for `destination: "property"`: the property comes from the FETCHED PDF / page text (`Prepared For` / `Billed To` address — reuse `addressIn` from `fetch/providers.mjs`, then the existing `verifyProperty` PDF read as the second opinion), never from the email (the email has no address). Known property folder → file to `Properties/<address>/Staging/` directly with the usual confirmation card (↩️ Undo); unknown → the existing "New property? Create Properties/<addr>/…" ❓ card. Refactor the campaign-destination code (`index.mjs` ~1061–1150, `vendorDestination`) only as much as needed to branch on `rule.destination`; ITI stays byte-for-byte in behaviour (its tests must not change).

# Part C — FreshBooks fetch provider

- `fetch/providers.mjs detectProvider`: host `my.freshbooks.com` with path/hash `#/link/…` → `"freshbooks"`; `freshbooksKind(url)` → `"proposal" | "invoice"` from `#/link/estimate/` vs `#/link/` (and the query params); `freshbooksNumber(url)` → `SS01174` / `080223VA`. `providerLabel` → "FreshBooks". `queuesOnSystemEmail`: FreshBooks emails are system emails and DO queue (like tapinspect).
- `fetch/freshbooks.mjs` (model on `tapinspect.mjs`): open the link in the persistent context (`openBrowser`), wait for the document to render (text `Proposal <n>` / `Invoice <n>` or the `Download PDF` button, up to ~20 s — it is a hash-routed SPA, `networkidle` may never settle), capture the download from the **Download PDF** button via `captureDownload`, read `page.innerText` for the address line and amount, screenshot each step via `makeShooter`. Click allowlist = `/^download pdf$/i` plus the usual `/^(close|ok|got it)$/i`; the refuse list already blocks sign/agree/submit — ALSO refuse `pay`, `accept`, `save this proposal`, `create an account`, `send`, `view comments`. Never type into anything. If no `Download PDF` appears (login wall, expired link) → `{ ok: false, error, needs: "login" | "expired" | null }` with the screenshot, and the job fails after the existing retry policy (no `awaiting_payment` dance here).
- `fetch/index.mjs fetchDocuments`: dispatch `"freshbooks"` → `fetchFreshBooks`; result files `[{ filename, bytes, mime: "application/pdf", kind: "staging_proposal" | "staging_invoice", pageText }]`. Timeout like tapinspect.
- Queueing: in the poll, a FreshBooks link from a message that `matchVendor` maps to a `destination: "property"` rule is queued in `inbox_fetches` (provider freshbooks, kind = the vendor doc type) — reuse the existing link-queue code path; dedupe on `url_sha256` as today.
- Filing after fetch: the fetched PDF goes through the vendor path (Part B) with `source: "fetch"`, property from `pageText`/PDF, name from Part A. The confirmation card reads like the tapinspect one ("📄 Filed StyleMe proposal SS01174 → 2116 Quito Rd/Staging"), with ↩️ Undo.

# Part D — Paid

- When the FreshBooks `$0.00` comment arrives for invoice N (already `completionEvent` kind paid): re-queue a fetch of the ORIGINAL invoice link (look up the filed `inbox_files` row for `StyleMe invoice N …` → its `inbox_fetches.url`), and on success REPLACE the file's bytes in Drive (`drive.files.update` media — add `updateFileContent(drive, fileId, mime, buffer)` to `drive.mjs`) and rename to `… PAID.pdf` (`paidName`). If the fetch fails, just rename. No Telegram card beyond a one-line "💸 StyleMe invoice 080223UP marked PAID" appended to the existing filed row's card via `tgEditText` if a card exists, else silent + log. Ryan's manual `💸 Paid` button (`ix:vp`) keeps working for ITI; it is not added to StyleMe cards (payment is detected automatically).
- `completionCloses` for FreshBooks already matches loops by invoice number — confirm with a test that the StyleMe "Pay invoice 080223VA" loop closes on the `$0.00` comment (it should already; add the assertion).

# Part E — backfill helper

- `scripts/inbox-agent/oneoff/oneoff-2026-10-17-styleme-backfill.mjs`: queues fetch jobs for the four known emails (`1a103e1371adb8cc` SS01168 Halleck, `1a1054b98ffa3062` 080223UP Halleck → will be filed then marked PAID because `1a13712751de3137` exists, `1a1273d89af371d2` SS01174 Quito, `1a14ab5d4cc45c46` 080223VA Quito) by reading each message's body links via the existing Gmail helpers, with `--dry-run` printing what would be queued. The operator runs it live.

# Non-goals

- No QuickBooks / XO Staging provider (leave the seam). No changes to the ITI rule's behaviour or names. No new standard subfolders beyond `Staging`. No paying, accepting or signing anything in the browser. No UI changes.

# Definition of done

- `npm test` green with new `tests/inbox-staging-vendor.unit.test.ts` (matchVendor with `sender_re`; `freshbooks` detection/kind/number on the two real URLs above; doc types from the subjects; names incl. PAID; destination = `Staging`; property from the page text `Prepared For … 2116 Quito Rd, San Jose, CA 95130` and `Billed To …`; ITI regressions untouched; random-sender `staging_invoice` still ignored; `$0.00` closes the StyleMe loop). `npx tsc --noEmit` clean. `next build` must still pass (`lib/inboxAgent.ts` imports).
- `briefs/BRIEF_INBOX_STAGING_VENDOR_FRESHBOOKS_2026-10-17.md` committed with the updated status line and a HANDOFF.

# HANDOFF (write this section at the end of the brief file when you finish)

List: the migration to apply (`node scripts/run-migration.mjs <file>`) and a SELECT that proves both vendor rules are present; the exact merge steps (ff `inbox-staging-vendor` into `main`, push, `git -C /Users/ryanlarocca/Projects/PROJECTS/mission-control pull --ff-only`); the live checks (`node scripts/inbox-agent/index.mjs --dry-run --message=<id>` for the four emails → expected log lines, then the backfill one-off live, then `--message=1a13712751de3137` live for the PAID rename); the selectors you guessed for the FreshBooks page (so the operator can fix drift from the screenshots in `/tmp/inbox-fetch/<job>/`); anything not covered by tests and why.

---

## HANDOFF (for the operator on the Mac mini)

Built on branch `inbox-staging-vendor` (cloud session, 2026-10-17). `npm test` = 548 passing (28 new in `tests/inbox-staging-vendor.unit.test.ts`), `npx tsc --noEmit` clean, `next build` green. Nothing live was touched: no migration run, no Gmail / Drive / Supabase / Telegram / FreshBooks calls.

What changed, file by file:

- `scripts/inbox-agent/fetch/providers.mjs` — `detectProvider` → `"freshbooks"` for `my.freshbooks.com/#/link/…`; `freshbooksKind` / `freshbooksNumber`; `providerLabel` "FreshBooks"; `queuesOnSystemEmail` true; new `queuesForVendor(provider, rule)` (a FreshBooks link queues only on a `destination: "property"` vendor email).
- `scripts/inbox-agent/fetch/freshbooks.mjs` (new) — the Download PDF flow, `SELECTORS`, `fbClickAllowed`, `freshbooksGate`, `freshbooksAddress`, `freshbooksAmount`, `parseFreshbooksPage`. `fetch/index.mjs` dispatches it (120 s cap) and re-exports the pure helpers.
- `scripts/inbox-agent/vendors.mjs` — the `styleme` rule in `DEFAULT_VENDORS`; `matchVendor` relays accept `sender_re`; `vendorDocType` branches on `rule.destination === "property"` → `stagingDocType`; `stagingNumberFrom`, `isPaidName`, `stagingInvoiceRowFor`, `STAGING_DOC_TYPES`. ITI's code path is unchanged (its tests did not move).
- `scripts/inbox-agent/filing.mjs` — `PROPERTY_SUBFOLDERS` gains `Staging`; `vendorFilename` names the two staging types (prefix = `rule.name_short`, `paid` → ` PAID`); `vendorPropertyFolder`. `llm.mjs subfolderFor` → `Staging` for both types (WHITELIST untouched).
- `scripts/inbox-agent/drive.mjs` — `updateFileContent(drive, fileId, mime, buffer)` (media update, same file id / link).
- `scripts/inbox-agent/index.mjs` — `fileVendorPropertyDocs` (property from the page text, PDF second opinion, Staging/ on first use, ❓ card when the property is unknown, files as PAID when the `$0.00` comment is already in `inbox_messages`); `fileFreshBooksJob` after a FreshBooks fetch; `enqueueFetches` / `systemLinks` gate FreshBooks links on the vendor rule and queue them with `kind = staging_proposal | staging_invoice`; `markStagingInvoicePaid` on the `$0.00` completion (re-queues the original job as `kind: staging_paid`), `applyStagingPaid` (replace bytes + rename + one `💸 … marked PAID` line on the card), `renameStagingPaid` (rename only when the re-pull fails or there is no link). `fileVendorDocuments` (ITI) only gained the one-line branch to the property path.
- `supabase/migrations/2026-10-17_vendor_styleme.sql`, `scripts/inbox-agent/oneoff/oneoff-2026-10-17-styleme-backfill.mjs`, `tests/inbox-staging-vendor.unit.test.ts`.

### 1. Migration (apply first, once)

```
node scripts/run-migration.mjs supabase/migrations/2026-10-17_vendor_styleme.sql
```

Idempotent. Seeds `inbox_settings.vendors` with the ITI rule only if the row is missing, then APPENDS the `styleme` rule unless a rule with that id already exists (`jsonb_set` + `||`, guarded by `NOT EXISTS … r->>'id' = 'styleme'`); the ITI rule is never rewritten. Also rewrites the `inbox_fetches.kind` column comment. Proof — expect exactly two rows:

```sql
select r->>'id' as id, r->>'destination' as destination, r->>'subfolder' as subfolder, r->'relays'->0->>'sender_re' as sender_re
from inbox_settings, jsonb_array_elements(value->'rules') r
where key = 'vendors';
-- iti     | (null)   | 3 - MAIL HOUSE | (null)
-- styleme | property | Staging        | @fb\d*\.freshbooks\.com$
```

The worker falls back to the same two rules from `DEFAULT_VENDORS` when the settings row is empty, but a settings row that carries ONLY the ITI rule (today's live state) hides StyleMe until this migration runs — apply it before merging.

### 2. Merge

```
cd /Users/ryanlarocca/Projects/PROJECTS/mission-control
git fetch origin inbox-staging-vendor
git checkout main
git merge --ff-only origin/inbox-staging-vendor
git push origin main
git -C /Users/ryanlarocca/Projects/PROJECTS/mission-control pull --ff-only
```

Vercel redeploys `main`; `lib/inboxAgent.ts` still imports only `fetch/providers.mjs` + `loops.mjs` (both pure) — the new FreshBooks detection makes a typed `fetch <freshbooks link>` queue a job too (see §5).

### 3. Dry runs (no DB writes, no Drive upload, no Telegram; the FreshBooks link IS opened in Chrome and the PDF lands in `/tmp/inbox-fetch/dry-<id>/files/`; Haiku reads the PDF's first page)

| Gmail id | What | Command | Expected log lines |
|---|---|---|---|
| `1a1273d89af371d2` | StyleMe proposal SS01174 (Quito) | `node scripts/inbox-agent/index.mjs --dry-run --message=1a1273d89af371d2` | `mail@fb0N.freshbooks.com · StyleMe Home Staging, LLC sent you a proposal… → <kind>`; `fetch dry-1a1273d89af371d2: FreshBooks attempt 1 · “StyleMe Home Staging, LLC sent you a proposal (SS01174)” · https://my.freshbooks.com/#/link/estimate/…`; `[fetch] freshbooks: link → document → download → <file>.pdf (N bytes) · staging_proposal`; `fetch dry-…: dry run — 1 file(s) in /tmp/inbox-fetch/dry-1a1273d89af371d2/files`; `vendor StyleMe Home Staging: would create Staging/ under Properties/2116 Quito Rd` (only while the subfolder does not exist yet); `vendor StyleMe Home Staging: filed <file>.pdf → Properties/2116 Quito Rd/Staging/StyleMe proposal SS01174 - 2026-10-10.pdf`; a dry-run Telegram card `📄 Filed StyleMe proposal SS01174 → 2116 Quito Rd/Staging` with `↩️ Undo`; `fetch dry-…: done — 1 file(s), 1 filed`. If `Properties/2116 Quito Rd` has no folder yet you get the ❓ `New property? … Create Properties/2116 Quito Rd/ with the standard subfolders?` card (guess `Properties/2116 Quito Rd/Staging/…`) instead. The email itself may also log `loop: Pay … (… · portal · fb0N.freshbooks.com\|2116quito\|payment)` — expected, the $0.00 comment closes it. |
| `1a14ab5d4cc45c46` | StyleMe invoice 080223VA (Quito, $3,253.75) | `node scripts/inbox-agent/index.mjs --dry-run --message=1a14ab5d4cc45c46` | Same shape with `· staging_invoice`, name `StyleMe invoice 080223VA - 2026-10-17 - $3,253.75.pdf` (amount from the body's `for $3,253.75`, else the page's `Amount Due (USD) $3,253.75`); card `📄 Filed StyleMe invoice 080223VA → 2116 Quito Rd/Staging`. |
| `1a103e1371adb8cc` | StyleMe proposal SS01168 (Halleck) | `node scripts/inbox-agent/index.mjs --dry-run --message=1a103e1371adb8cc` | `… → Properties/5764 Halleck Dr/Staging/StyleMe proposal SS01168 - 2026-10-03.pdf` (the Halleck folder exists → files directly). |
| `1a1054b98ffa3062` | StyleMe invoice 080223UP (Halleck, $2,985) | `node scripts/inbox-agent/index.mjs --dry-run --message=1a1054b98ffa3062` | `… filed <file>.pdf → Properties/5764 Halleck Dr/Staging/StyleMe invoice 080223UP - 2026-10-04 - $2,985.00 PAID.pdf ($2,985.00) · already paid` — PAID straight away because `1a13712751de3137` ("… 080223UP ($0.00)") is already in `inbox_messages`. On the paid FreshBooks page `Amount Due` reads `$0.00`; the name takes the first non-zero amount (body `for $…`, else the page's `Total`). |
| `1a13712751de3137` | FreshBooks "… 080223UP ($0.00)" | `node scripts/inbox-agent/index.mjs --dry-run --message=1a13712751de3137` | `completion event: freshbooks paid · invoice 080223UP` (as before), then `vendor paid: no filed StyleMe invoice 080223UP on file — nothing to mark` (before the backfill) or `vendor paid: StyleMe invoice 080223UP - … PAID.pdf is already marked PAID` (after it). No FreshBooks link is queued from a comment email (`matchVendor` → null). |
| backfill | the one-off, dry | `node scripts/inbox-agent/oneoff/oneoff-2026-10-17-styleme-backfill.mjs --dry-run` | four `<id>: would queue StyleMe Home Staging staging_<type> — "<subject>" · https://my.freshbooks.com/…` lines and `dry run — 4 job(s) would be queued`; `<id>: no inbox_messages row — would insert a minimal one` for any id the watcher never recorded. |

Fetch CLI (no DB at all), to probe one link first — add `--headed` to watch it:

```
node scripts/inbox-agent/fetch/cli.mjs --url "<the my.freshbooks.com/#/link/… URL from 1a1273d89af371d2>" --out /tmp/styleme-ss01174
```
Expected: `provider freshbooks`, `[fetch] freshbooks: link → document → download → <file>.pdf (N bytes) · staging_proposal`, the PDF in `/tmp/styleme-ss01174/`. Screenshots: `/tmp/inbox-fetch/<job>/01-link.png`, `02-document.png`, `03-downloaded.png` (or `02-not-rendered.png` / `02-no-download-pdf.png` / `02-login.png` / `02-expired.png` on failure).

### 4. Live (in this order, after the migration + merge)

```
node scripts/inbox-agent/oneoff/oneoff-2026-10-17-styleme-backfill.mjs      # 4 inbox_fetches rows, provider freshbooks, kind staging_proposal|staging_invoice, status queued
node scripts/inbox-agent/index.mjs                                           # pass 1 runs 3 jobs (3 fetches per pass); pass 2 the 4th → each: filed + card `📄 Filed StyleMe … → <address>/Staging`
node scripts/inbox-agent/index.mjs                                           # (or wait for launchd's next 5-min pass)
node scripts/inbox-agent/index.mjs --message=1a13712751de3137                # $0.00 for 080223UP → "already marked PAID" (filed as PAID by the backfill), or, if it was filed unpaid:
                                                                             #   "vendor paid: re-pulling the FreshBooks invoice (job <id>, was done) …" → next pass: "fetch <id>: paid copy replaced … → … PAID.pdf" + one 💸 line edited onto the card
```
Check: `select final_folder, final_name, meta from inbox_files where doc_type in ('staging_proposal','staging_invoice') order by received_at;` → four `filed` rows under `Properties/5764 Halleck Dr/Staging` and `Properties/2116 Quito Rd/Staging`, the 080223UP name ending ` PAID.pdf`, `meta.paid_at` set. Then, when Ryan pays 080223VA, the live `$0.00` comment logs `vendor paid: re-pulling …` and the following pass replaces the file with the paid copy and renames it; the card gets `💸 StyleMe invoice 080223VA marked PAID`.

### 5. Selectors guessed for the FreshBooks page (`SELECTORS` at the top of `scripts/inbox-agent/fetch/freshbooks.mjs`)

- `downloadPdf` `/^download pdf$/i` — tried as a button role, a link role, `aria-label*="download pdf"`, `data-testid*="download-pdf"`, then visible text. The operator saw the label "Download PDF"; if the button is an icon with a tooltip only, add its aria-label here.
- `heading` `/\b(proposal|invoice|estimate)\s*…number/i` — the render signal ("Proposal SS01174" / "Invoice 080223VA").
- `forbidden` — pay / payment / accept / save this proposal / create an account / send / view comments / view history / print / sign / agree / submit / decline / log in / sign in / password. Judged before the allowlist on every candidate label.
- `login` / `expired` — the gate texts when no Download PDF shows: a credentials wall → `needs_login` (card, status `needs_login`), a dead link → `expired` (card, status `expired`), neither → the normal 3-attempt retry (5 min, 30 min) then the ⚠️ card.
- `addressLead` `/(?:prepared for|billed to|bill to|client)\s*:?\s*/i` — the property is read from the 4 lines after it first (the vendor's own San Jose address appears higher on the page), then anywhere in the text; `verifyProperty` (Haiku on the PDF) is the second opinion and a disagreement ≥ 0.6 confidence asks instead of filing.
- `amount` — `for $X` (email body) → `Amount Due (USD) $X` → `Grand total` → `Total $X` → `Outstanding $X`; the first non-zero hit wins, so a paid page's `$0.00` never names the file.
- The flow waits up to 20 s (`FRESHBOOKS_RENDER_WAIT_MS`) for the document because `networkidle` never settles on the hash-routed SPA; the whole job is capped at 120 s.
- `captureDownload` listens for a download on the SAME tab. If Download PDF opens the PDF in a new tab instead, the job fails with `Download PDF produced no file` — the fix is a `pageAfterClick`-style popup wait like `tapinspect.mjs` has.

### 6. Not covered by tests, and judgement calls

- **The browser flow itself** (button discovery, the download event, the exact page text) — only the pure pieces are tested; the probe texts in the tests are modelled on what the operator reported. Screenshots in `/tmp/inbox-fetch/<job>/` are the drift signal.
- **`inbox_files.source` is `"freshbooks"`** (the provider, like `"tapinspect"`), not the brief's literal `"fetch"` — consistent with the existing column convention (`attachment | docusign | manual | tapinspect`); nothing reads it for routing except the media check.
- **`PROPERTY_SUBFOLDERS` is documentation.** No code path creates the standard set for a new property — the ❓ "with the standard subfolders" card only ever created the one path the answer named, before this build too. Staging/ is created on first use by `resolvePath(…, { create: true })`, exactly as the brief asks; nothing is created pre-emptively.
- **Paid at filing time.** If the `$0.00` comment is already in `inbox_messages` when the invoice is filed (the 080223UP backfill), the file is named ` PAID` from the start with the paid copy's bytes — no re-pull needed. The re-pull path (`staging_paid`) is for the live order: invoice filed first, payment later.
- **Paid re-pull failures are silent.** Retries ride the normal backoff; after the third failure the file is renamed ` PAID` without new bytes and the job is `failed` with `paid re-pull failed (…); renamed PAID without new bytes` — no card (Ryan already saw the $0.00 email).
- **A typed `fetch <freshbooks url>`** (Telegram) now queues (`detectProvider` says freshbooks). With no vendor email behind it (a `manual:` message), the job takes the first `destination: "property"` rule whose `doc_types` lists the document's kind (StyleMe today); a `fetch` reply on a card keeps the same vendor gate as the poll (`lib/inboxAgent.ts enqueueLinksForMessage`), so another vendor's FreshBooks email never files as StyleMe. A second staging vendor on FreshBooks would need its own sender/subject relay to be told apart on typed links.
- **HTML-only emails.** `gmail.mjs htmlToText` strips `<a href>` tags, so a StyleMe email with no `text/plain` part would carry no URL in `msg.text` (pre-existing for every provider). The backfill dry run shows it as `no FreshBooks document link in the body`; the fix would be to emit `href` values in `htmlToText` before stripping tags.
- **Independent review (subagent) applied before the push:** the `$0.00` handler is wrapped so a Drive / Supabase hiccup can never turn the receipt email into an `error` row; a crash inside the paid re-pull routes to the quiet rename-and-fail path (never the generic ⚠️ retry card); the job's `error` text says when the fallback rename itself failed; the render-signal regex requires a digit in the document id ("invoice from" is prose).
- **ITI's `💸 Paid` button** is unchanged and is not on StyleMe cards; `ix:vp` still refuses non-`invoice` rows ("Not an invoice").
- **The XO Staging / QuickBooks seam:** `AUTOMATED_RE` in `index.mjs` drops `notification.intuit|quickbooks@` at the poll before any classifier or vendor match runs — the QuickBooks provider will need that exclusion lifted (or a vendor-match check ahead of it) as well as a `detectProvider` entry and a rule.
- **Classifier behaviour** on the StyleMe emails (whether they come back `automated` or `human`, `needs_reply`) is prompt-only; both routes queue the link (the vendor rule is the gate, not the kind).
