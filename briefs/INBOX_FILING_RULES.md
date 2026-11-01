<!-- Inbox Agent filing convention v2 — written with Ryan 2026-10-02. The agent reads the approved copy from inbox_settings.rules.md; this file is the checked-in mirror. -->

# Ryan LaRocca — Google Drive Filing Convention (v2, 2026-10-02)

## The rule in one line
Only transaction documents are filed. Everything else that arrives on a deal thread is remembered but never uploaded and never produces a card.

## What gets filed (the transaction whitelist)
- Purchase agreement (RPA), counter offers, addenda, contingency removals
- Disclosures (TDS, SPQ, seller/agent disclosures) and the natural hazard disclosure report
- Preliminary title report
- EMD wire / deposit receipts
- Inspection reports (property inspection, termite/WDO, appraisal)
- **Every** settlement statement, every version, never overwritten
- **Final** loan documents only (signed note, deed of trust, closing disclosure)
- **Bound** insurance only: the evidence of insurance / binder and the issued policy or declarations page
- Marketing lists (CSV/XLSX owner or farm lists from a title rep) → `Marketing/`, never `Properties/`
- **Construction-draw paperwork from any lender** (draw request form / DRF, lien package, lien waivers, draw schedule, draw approval) → `Construction/`, every stage (Ryan 2026-10-06; before this the DRF was dropped as an "invoice")

## What is never filed
Insurance quotes, replacement-cost estimates, policy applications and the "disclosures" that ride along with them; loan applications, borrowing authorizations, affidavits (BPA), lender guides and rate sheets; invoices (except draw paperwork, which is a draw request); offering memoranda and flyers from broker blasts; Zoom invites; lender or vendor marketing. These are logged (`inbox_files.status = ignored`) so `find` can still pull them from Gmail.

## Property folder structure (active deals, directly under Properties/)
```
Properties/<number street>/          e.g. 5764 Halleck Dr, 2116 Quito Rd
  Purchase & Sale/                   the negotiation timeline, two-digit prefix in order
    01 Offer RPA 2026-08-25.pdf
    02 Counter Offer 2026-08-26.pdf
    03 Addendum 1 2026-09-10.pdf
    04 Contingency Removal 2026-09-20.pdf
  Disclosures/                       TDS, SPQ, NHD report, seller + agent disclosures (sender's filenames kept)
  Inspections/                       termite/WDO, property inspection, appraisal (sender's filenames kept)
  Title & Escrow/
    <property> Prelim <date>.pdf
    <property> EMD Receipt <date>.pdf
    <property> Buyer Statement <date> estimated.pdf     ← "Buyer" when Ryan is buying, "Seller" when selling
    <property> Buyer Statement <date> FINAL.pdf
    <property> Grant Deed <date>.pdf
  Loan & Insurance/                  final loan docs (sender's name), EOI (sender's name), <property> Insurance Policy <date>.pdf
  Offers/                            offers Ryan RECEIVES on a property he is selling (since 2026-11-01) — one folder per offer, the whole package together
    Coko LLC $1.5M offer 2026-10-30/
      Offer RPA 2026-10-30.pdf
      Buyer Contingency Removal 2026-10-30.pdf
      Buyer Closing Statement 2026-10-30.pdf
      Proof of Funds 2026-10-30.pdf
      Escrow Wire Instructions 2026-10-30.pdf
      Counter Offer 2026-11-02.pdf       ← a later counter / addendum for the same buyer joins the same folder
  Construction/                      draw paperwork from any lender (DRF / draw request form, lien package, lien waivers, draw schedule, draw approvals — sender's name, every stage; since 2026-10-06); bids, invoices, permits (Ryan files these by hand)
  Photos/
```
Closed deals stay where they are until Ryan says otherwise (`Properties/Old/`, `Properties/2025/` untouched). `93 Ridgeview` keeps its current name and layout — do not rename or restructure it.

## Offers Ryan receives (he is the seller)
The buyer named on the first page of the RPA / counter decides. If it is not Ryan, LRG Homes or Charity Doors LLC (plus `inbox_settings.agent.our_names`), the email is an **offer package**: every piece the buyer's agent sent — RPA, counters, addenda, the buyer's contingency removal, their closing statement / net sheet, EMD receipt, proof of funds / pre-approval, escrow wire sheet — files together into `Properties/<addr>/Offers/<buyer> <price> offer <date>/` with short dated names. Nothing from it ever enters the numbered Purchase & Sale chain (that is Ryan's own purchase). A buyer-representation agreement stays out. No statement diff on buyer-side statements.

## The same document twice is filed once (2026-11-01)
Ryan: "sometimes humans make errors, they send them twice etc but we should dedupe the disclosures on our end." Byte hashes miss re-sends (DocuSign regenerates every PDF), so names decide: `Market_Conditions_Advisory_-_6_24.pdf`, `Market Conditions Advisory - 624.pdf` and `… (1) (1).pdf` are one document. Same name on the same email (attachment + the copy pulled from its DocuSign link) → duplicate, no second file. Same name already in the property folder with the same size (±0.5 %) → duplicate. Same name but materially different bytes (a re-signed disclosure, an updated report) → a new version filed under the existing spelling with the time suffix, next to the old one. DocuSign's `Summary.pdf` (the certificate of completion) is never a disclosure.

## Money that crosses deals
When proceeds from one property fund another (e.g. the 93 Ridgeview disbursement wired into the 5764 Halleck Dr escrow), the disbursement / wire document is filed with the **receiving** property too, under Title & Escrow, so that file balances on its own later. A document naming two properties is not a misfile — check which escrow the money landed in.

## Settlement statements
- File every version. Name = `<property> <Buyer|Seller> Statement <YYYY-MM-DD>` + ` FINAL` when the sender calls it final, otherwise ` estimated`. Two on the same day → the second gets the time appended.
- On each new one, read it against the previous version in the same folder and put a one-line "what changed" on the confirmation.

## Which property? Read the document.
For purchase agreements, counters, addenda, settlement statements, prelims and insurance, the property comes from the first page of the PDF (the "Property" line, the APN, the address on the statement), not from the email subject. One email or DocuSign envelope = one property; attachments are never split across folders. If the PDF and the email disagree, ask — never guess.

## Marketing lists
Dominic Wooten (Chicago Title) and other title reps send CSV/XLSX farm lists. They go to `Marketing/<year>/<Month><Year> Lists/` (Ryan's own style: `Marketing/2026/NOO October2026`), filename kept. Zoom invites from the same people are not filed.

## Cards
- Whitelisted document on a known property → filed immediately, one confirmation card per email with ↩️ Undo.
- Property unknown or new → one ❓ card: ✅ Use the guess · ✏️ Tell me where (reply with the folder) · ⏭ Skip.
- Anything not on the whitelist → nothing.
- Broker blasts from unknown senders → nothing, anywhere. Direct deals and blasts from people Ryan has done business with still get the deal card.

## Taxes
1099-S, 1098 and returns → `Taxes/<year>/`, never inside a property folder.
