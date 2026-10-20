# E-sign v2 — see earlier signatures, addendum box, Expiration clause

Status: **built 2026-10-20 on branch `esign-v2`** (Ryan approved the brief
on 2026-10-20: Expiration default 3 calendar days, clause wording as below;
scope change relayed by the bridge session the same day: the page-2 line is a
**checkbox only** — no names field, the extra signers are named on the
Signature Addendum — with the wording "Additional Seller(s) and/or Buyer(s)
have signed the attached Signature Addendum, which is incorporated into and
made a part of this Agreement."). Commits:

- `93b5820` feat(esign): rebuild the agreement template from a script — term 4 Expiration, addendum checkbox (D)
- `22765e6` feat(esign): interim signed view; addendum box ticked (A + B)
- `05301df` test(esign): e2e proves the interim view, the ticked box and the original fingerprint
- `8096952` feat(offer-bot): term 4 Expiration in the parser, card, Mini App and PDF fill (C)
- `e79ed70` docs: `briefs/ESIGN.md`, `briefs/OFFER_BOT.md`, this file
- follow-up: checkbox only (drops `addendum_names`, new wording)

Still to do from the Mac mini (needs Drive + `.env.local`): upload
`esign/assets/template-reference.pdf` with Drive `files.update` on
`1ACbeyT4mC4u_fUCBZ1YnhVs-tpEFBR2F` (`esign/template/README.md`), `git pull`
+ restart e-sign, run `npm run test:e2e` and an offer-bot dry run, then a
phone test. Envelopes in flight keep their own `original.pdf`; the builds
skip the addendum box when the template lacks it.

Implementation notes beyond the plan: the interim is also built at creation
when the envelope has addendum signers, so the first signer already sees the
ticked box and the addendum page (a signer who hasn't signed yet gets an
empty line there); page 1 of the template uses 11.4pt leading / 3pt term gap
(page 2 keeps 12 / 4 and every coordinate below the terms); the drawn
coordinates are in `briefs/ESIGN.md` → "Template coordinates".

Original brief follows. Three asks from his first real signing run on
576 Apple St (seller signed first, Ryan signed second as Buyer).

## What Ryan saw and why

1. **The seller's signature was not on the page when Ryan signed.**
   Root cause: `esign/` renders the page images once, from `original.pdf`,
   when the request is created (`lib/pdf.mjs renderPages`). Signatures are
   only drawn at the very end (`buildFinalPdf`, when the last signer
   finishes). A second-tier signer therefore reviews a blank agreement, and
   "Open as a PDF" on the review page is the unsigned original too.
2. **No "additional signers" box on the agreement.** Extra sellers/buyers go
   on the generated Signature Addendum, but page 2 of the agreement says
   nothing about it, so a reader of page 2 alone cannot tell more signatures
   exist (CAR forms tick a box pointing at the ASA form).
3. **No Expiration clause.** The agreement never says when the offer dies.
   CAR's RPA language: *"This offer shall be deemed revoked and the deposit,
   if any, shall be returned to Buyer unless the offer is Signed by Seller
   and a Copy of the Signed offer is personally received by Buyer … by
   5:00 PM on the third Day after this offer is signed by Buyer (or by
   __ AM/PM on __ (date))."*

Items 2 and 3 are **template changes**, not e-sign changes. The template is
the Drive PDF `Real_Estate_Purchase_Sale_Agreement.pdf` (id
`1ACbeyT4mC4u_fUCBZ1YnhVs-tpEFBR2F`), a ReportLab-generated 2-page form
with 13 text fields. **No generator source exists in any repo** (it was a
one-off on 2026-10-15), so the template has to be rebuilt from a script
we keep this time.

## Plan

### A. Earlier signatures show up for later signers (e-sign only)

- After every signature, build an **interim signed PDF** from
  `original.pdf` + everyone who has signed so far (reuse the existing
  `buildFinalPdf` drawing code, minus the certificate): dates filled,
  signature on the template line, addendum page(s) appended for addendum
  signers. Save as `envelopes/<id>/interim.pdf`, re-render the page PNGs
  from it, update the displayed page count.
- Review page, "Open as a PDF", and the admin detail page all read the
  interim file when it exists. `original.pdf` is never touched, so the
  Certificate's original fingerprint is unchanged; `signed.pdf`/`final.pdf`
  are still built from the original at the end exactly as today.
- Seller-signed copy is also what Ryan sees when his turn comes, so he is
  counter-signing a document that already carries the seller's ink.
- Edge: the "Sign here" tab for a template signer stays at the same
  coordinates (pages 1–2 are unchanged by the interim build; addendum pages
  are appended after them).

### B. "Additional signers" box on page 2 (template + e-sign)

- Add one line under the Seller block on page 2 of the template:
  `☐ Additional Seller(s) / Buyer(s) sign on the attached Signature
  Addendum, which is part of this Agreement.  Names: ______________`
  as two fields: checkbox `addendum_attached` and text `addendum_names`.
- E-sign ticks the box and fills the names **at send time** (interim PDF
  from step A, so the first signer already sees it) whenever the envelope
  has any addendum signer. The offer bot leaves both blank.
- The addendum page itself gets a matching header line: "Referenced by the
  checked box on page 2 of the Agreement."

### C. Term 4 "Expiration" (template + offer bot + Mini App)

- Insert as **new term 4**, renumber 4–22 → 5–23. Two cross-references must
  move with it: term 2 says "except as provided in para. 5" (Buyer's
  Extensions → becomes para. 6) and term 15 says "Cancellation pursuant to
  para. 9" (→ para. 10).
- Proposed text (mirrors CAR, in the agreement's voice):
  > **4. Expiration.** This offer shall be deemed revoked and any earnest
  > money deposit returned to Buyer unless this Agreement is signed by
  > Seller and a signed copy is delivered to Buyer by 5:00 p.m. Pacific
  > time on ______________ (the "Expiration Date"). If no Expiration Date
  > is entered, this offer expires at 5:00 p.m. Pacific time on the
  > ______ calendar day after the date Buyer signs this Agreement.
- New template fields: `expiration_date` (MM/DD/YYYY) and
  `expiration_days` (integer). Offer bot: new field `expiration` — Ryan can
  say "expires Friday" / "good for 5 days"; **default = 3 calendar days
  from the agreement date** (CAR's default), rendered as the actual date.
  Mini App form and review card gain the field. One extra row in
  `briefs/OFFER_BOT.md`'s field table.
- Page 2 is already full (stipulations box + two signature blocks + the new
  checkbox line). The extra paragraph on page 1 pushes ~5 lines down; the
  rebuild tightens leading slightly rather than spilling to a page 3, so the
  document stays 2 pages (`inspectPdf` requires exactly 2 pages, letter size,
  the 3 named fields).

### D. Template rebuild (the enabling work)

- New script `esign/template/build_template.py` (ReportLab + pypdf for the
  AcroForm fields), checked in, reproduces the current document line for
  line plus B and C. Output committed as `esign/assets/template-reference.pdf`.
- Upload with Drive `files.update` on the **same file id** so the offer bot
  needs no config change; the old revision stays in Drive's version history.
- Re-measure and update `TEMPLATE` in `esign/lib/pdf.mjs` (signature line
  x / y / width, date fields) and the new checkbox coordinates; re-run the
  Playwright e2e (`npm run test:e2e`) and the offer-bot dry run.
- The two in-flight envelopes keep working: an envelope stores its own
  `original.pdf`; only new requests pick up the new template.

### Surfaces touched (gate per the "every surface" rule)

| Surface | A | B | C |
|---|---|---|---|
| Template PDF (Drive + `assets/template-reference.pdf`) | | ✓ | ✓ |
| `esign/lib/pdf.mjs` (interim build, box tick, coords) | ✓ | ✓ | ✓ |
| `esign/server.mjs` + `views/pages.mjs` (serve interim pages/PDF, admin preview) | ✓ | | |
| `lib/offerContract.ts` + `lib/offerBot.ts` (parse, card, fill) | | | ✓ |
| `app/offer/page.tsx` Mini App form | | | ✓ |
| `briefs/ESIGN.md`, `briefs/OFFER_BOT.md`, e2e tests | ✓ | ✓ | ✓ |

### Decisions for Ryan (one tap each)

1. **Expiration default:** 3 calendar days (CAR) — or a different number?
2. **Expiration wording above** OK as written, or send me your tweak?
3. **Checkbox wording** OK, or do you want the extra names printed too
   (proposed: yes, "Names: …" filled by e-sign)?
4. **Go:** build on the cloud credit (code + template script), then I
   upload the template, restart e-sign on the mini, and re-test on the
   phone before telling you it's live.

### Not in this brief

Changing who signs on the template's own line (still first Seller + first
Buyer). SMS codes. Anything on the Certificate.
