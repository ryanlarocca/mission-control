---
name: sign-document
description: Help Ryan sign a form someone sent him (access acknowledgment, waiver, disclosure receipt, LOI, any PDF with blanks) — find it, read it, fill the blanks, flag real exposure, hand him an e-sign link that signs on the form's own lines, file it in Drive, share view-only on his say-so. Use when Ryan says "help me sign this", "sign the thing X sent", "I need to sign…", or sends a PDF/Drive link to sign. Not for DocuSign/Dotloop links (he signs those on their site) and not for his own purchase agreement (offer bot + /admin).
---

# Help Ryan sign a document

Ryan asks in chat; nothing here runs on its own. **Nothing is signed until he taps
Finish on the e-sign page, nothing is sent back to the sender, and nothing is
shared until he says so.**

Tools: `esign/scripts/find-blanks.mjs` (where the blanks are) and
`esign/scripts/self-sign.mjs` (prepare / status / share / void). Both run from
the repo root against the live e-sign data on the Mac mini. In a worktree,
`esign/node_modules` is missing — symlink it from the main checkout first
(`ln -s /Users/ryanlarocca/Projects/PROJECTS/mission-control/esign/node_modules esign/node_modules`)
and never commit that symlink.

## 1. Find the document

- Texts first: `node scripts/pile/ask.mjs person "<name>"`; seller leads text the
  Twilio lead lines, so also check their Leads rows (`leads` where
  `caller_phone` = their number, newest first) for a Drive/Docs link or attachment.
- Email only when he says email.
- A Drive link → download with DWD as ryan@ (`esign/lib/google.mjs` →
  `driveClient()` + `driveDownload()`); a Google Doc must be exported to PDF
  first (`files.export`, `application/pdf`).
- Save it in the scratchpad, in its own folder.

## 2. Read it and find the blanks

`node esign/scripts/find-blanks.mjs <form.pdf> --png <dir>` → JSON of every
blank line per page (`x`, `lineY`, `w` in PDF points, `label`, `source`) +
page PNGs. **Look at every page image yourself.**
- `source: "text"` = underscores in the text layer (label = the words before it).
- `source: "drawn"` = a ruled line found in the image (drawn lines, scans);
  scans have no labels — read the label off the image.
- Blanks the finder missed (boxes, a line under a caption it didn't pair):
  measure on the PNG (`--png` renders at 144 dpi = 2 px per point; PDF y =
  page height − px/2).

## 3. Fill the blanks

Profile (Ryan approved 2026-11-04):
- **Name:** Ryan LaRocca · **Company:** LRG Homes · **Email:** ryan@lrghomes.com
- **Phone:** the number that person already has from him (for a seller lead,
  the lead line they've been texting — e.g. (650) 670-3914), **never his cell**.
- **Date:** a `date` field — today in Pacific time, stamped at signing.
- **Property address:** from the lead / the form itself.

Rules:
- **Never fill SSN, EIN, tax ID, bank or card details** — leave blank and tell him.
- **Buyer entity on anything binding** (contract, LOI, assignment): ask which
  entity — don't default to LRG Homes.
- Anything you're not sure of → ask, don't guess. Skip blanks that are for the
  other party (Owner/Seller signature, their date).
- Every signature/initials line for Ryan is a `signature` field (all get his signature).

## 4. Flag real exposure — one line each

Liability release / indemnity / hold harmless, personal guarantee, deposits or
fees, exclusivity / non-circumvent, auto-renewal, waiver of inspection or
disclosure rights, anything that binds him past the visit or the deal.
One plain line each, no coaching, no rewrites (see
`feedback-seller-rapport-attorney-advice`). Nothing stands out → "nothing unusual".

## 5. Prepare and check the preview

Write a spec (scratchpad) and run `node esign/scripts/self-sign.mjs prepare <spec.json>`:

```json
{ "pdf": "<scratchpad>/form.pdf", "docLabel": "Access Acknowledgment",
  "street": "5122 Severance Ct", "propertyAddress": "5122 Severance Ct, San Jose, CA",
  "receivedFrom": "Maryam Norton",
  "fields": [
    { "page": 1, "kind": "text", "value": "Ryan LaRocca", "label": "Name", "x": 104.5, "lineY": 341, "w": 142.4 },
    { "page": 1, "kind": "text", "value": "LRG Homes", "label": "Company", "x": 120.2, "lineY": 313.5, "w": 131.5 },
    { "page": 1, "kind": "date", "label": "Date", "x": 99.1, "lineY": 286.5, "w": 147.9 },
    { "page": 1, "kind": "signature", "label": "Signature", "x": 120.5, "lineY": 259, "w": 126 } ] }
```

It prints `{ id, link, preview: [page PNGs], filingFolder }`. **Open the preview
PNGs and check every fill-in sits on its line** before giving Ryan anything; if
one is off, `void` it and prepare again. Then optionally load the link on a
phone viewport (Playwright iPhone) to see the yellow Sign here tab on the line.

## 6. Hand Ryan the link

Send: what the form is (2–3 lines), the fill-ins, the exposure flags, and the
link. He opens it, checks the page, taps **Sign here → Finish**. Telegram tells
him "✍️ Ryan LaRocca signed …" and "✅ … fully signed" with the Drive links.

On completion e-sign files to
`Business Operations/E-Sign/Signed by Ryan/<YYYY-MM-DD> · <street> · <label>/`:
`<label> - original.pdf` (as received), `<label> - signed.pdf` (clean — the one
to share), `<label> - signed + certificate.pdf` (his record; the certificate
shows his IP/location — never share it). He also gets the certificate copy by email.

`node esign/scripts/self-sign.mjs status <id>` → signed? + Drive links.

## 7. Share — only when he says

`node esign/scripts/self-sign.mjs share <id> <their email>` → view-only on the
**clean signed file only** (never the folder, never the certificate copy), no
Google notification email. Returns the link.

Then **ask** whether to text it back; only on his yes, text it from the line
that person already uses: a seller lead → Mission Control `POST /api/leads/send`
`{ phone, message }` (prod, logged-in cookie — see `mission-control-local-auth-testing`),
which texts from the lead line they contacted and logs it on their card. Never
his cell, never osascript. A non-Google email may not open the file without a Google
sign-in — if so, say so and offer to email the clean PDF from ryan@ instead.
