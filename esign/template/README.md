# Purchase & Sale Agreement template

`build_template.py` is the source of `../assets/template-reference.pdf` — the
2-page fillable Real Estate Purchase & Sale Agreement the offer bot fills
(`briefs/OFFER_BOT.md`) and e-sign signs (`briefs/ESIGN.md`). Edit the script,
never the PDF.

**Build** (needs `reportlab` and `pypdf`; `pdftotext` / `pdftoppm` to check):

```
python3 esign/template/build_template.py
```

It writes `esign/assets/template-reference.pdf`, asserts 2 pages, and prints
every field rectangle plus the coordinates e-sign's `TEMPLATE`
(`esign/lib/pdf.mjs`) depends on. Compare against the previous build with
`pdftotext -layout` (text) and `pdftoppm -r 80 -png` (look).

**Upload** — the live template is the Drive file
`Real_Estate_Purchase_Sale_Agreement.pdf`, id `1ACbeyT4mC4u_fUCBZ1YnhVs-tpEFBR2F`
(`OFFER_TEMPLATE_FILE_ID`). Replace its *content* in place with Drive
`files.update` (media upload, `supportsAllDrives: true`) so the id, the offer
bot config and the old revision in Drive's version history are all kept:

```
node -e '
  import("./lib/google.mjs").then(async ({ driveClient }) => {
    const drive = await driveClient()
    const fs = await import("node:fs")
    const r = await drive.files.update({ fileId: "1ACbeyT4mC4u_fUCBZ1YnhVs-tpEFBR2F", supportsAllDrives: true,
      media: { mimeType: "application/pdf", body: fs.createReadStream("assets/template-reference.pdf") }, fields: "id, name, modifiedTime" })
    console.log(r.data)
  })'
```

(run from `esign/` on the Mac mini, where `.env.local` has the service account).
Envelopes already in flight keep their own `original.pdf`; only new requests
pick up the new template. After an upload, restart e-sign and run
`npm run test:e2e` plus an offer-bot dry run.

**Fields** (all Helvetica 9pt; the 13 from `briefs/OFFER_BOT.md` plus):

| field | type | filled by |
|---|---|---|
| `expiration_date` | text, MM/DD/YYYY | offer bot (term 4) |
| `expiration_days` | text, integer | offer bot (term 4) |
| `addendum_attached` | checkbox | e-sign, when the envelope has addendum signers (their names are on the Signature Addendum) |

The light-blue boxes are page content *and* the widgets' appearance, as in
the 2026-10-15 original, so they stay on the flattened signed copy.
