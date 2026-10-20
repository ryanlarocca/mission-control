// PDF work: fingerprints, page images for the phone view, the interim build
// (what later signers review) and the final assembly (signatures on the
// agreement, signature addendum, certificate).
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { PDFDocument, StandardFonts, rgb, PDFName, PDFBool } from "pdf-lib"
import fontkit from "@pdf-lib/fontkit"
import { APP_ROOT, env } from "./env.mjs"
import { geoLabel, deviceLabel } from "./geo.mjs"
import { CONSENT_VERSION } from "./consent.mjs"
import { SIGNATURE_FONTS, fontKey } from "./fonts.mjs"

const execFileP = promisify(execFile)
const PDFTOPPM = fs.existsSync("/opt/homebrew/bin/pdftoppm") ? "/opt/homebrew/bin/pdftoppm" : "pdftoppm"
const FONT_DIR = path.join(APP_ROOT, "assets", "fonts")

/** Embed (once per document) the script font a signer picked. */
async function scriptFontFor(doc, fonts, signer) {
  const key = fontKey(signer.signature_font)
  fonts.scripts ??= {}
  if (!fonts.scripts[key]) fonts.scripts[key] = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, SIGNATURE_FONTS[key].file)), { subset: false }) // Allura breaks under subsetting
  return { font: fonts.scripts[key], size: SIGNATURE_FONTS[key].pdfSize }
}

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

/**
 * Ryan's Purchase & Sale Agreement template (esign/template/build_template.py):
 * 2 letter pages, text fields including seller_signer_name / seller_date /
 * buyer_date, signature lines at known spots on page 2. Coordinates are PDF
 * points, origin bottom-left, measured from the 2026-10-20 build — the lines
 * are where the 2026-10-15 document had them, so envelopes created from the
 * older template still sign in the right place. The addendum checkbox under
 * the Seller block only exists from 2026-10-20 on; the builds tick it when
 * the field is there and skip it otherwise.
 */
export const TEMPLATE = {
  page: 1,
  buyer: { x: 309, lineY: 280.2, w: 249 },
  seller: { x: 309, lineY: 200.8, w: 249 },
  dateField: { buyer: "buyer_date", seller: "seller_date" },
  addendum: { checkbox: "addendum_attached" }, // rect 54 124 64 134
}

export async function inspectPdf(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const pages = doc.getPages()
  let fields = []
  try { fields = doc.getForm().getFields().map((f) => f.getName()) } catch { fields = [] }
  const p2 = pages[1]?.getSize()
  const isTemplate =
    pages.length === 2 &&
    ["seller_signer_name", "seller_date", "buyer_date"].every((n) => fields.includes(n)) &&
    !!p2 && Math.round(p2.width) === 612 && Math.round(p2.height) === 792
  return { pageCount: pages.length, fields, isTemplate }
}

/** Render every page to PNG (110 dpi ≈ 935px wide — crisp on a phone). */
export async function renderPages(pdfPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  await execFileP(PDFTOPPM, ["-r", "110", "-png", pdfPath, path.join(outDir, "page")])
  const files = fs.readdirSync(outDir).filter((f) => /^page-\d+\.png$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  // Normalise names to page-1.png … so the web routes don't care about padding.
  const out = []
  files.forEach((f, i) => {
    const want = `page-${i + 1}.png`
    if (f !== want) fs.renameSync(path.join(outDir, f), path.join(outDir, want))
    out.push(want)
  })
  return out.length
}

// ---------------------------------------------------------------- dates

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
function dateOnly(iso) {
  const m = DATE_ONLY.exec(String(iso))
  return m ? `${m[2]}/${m[3]}/${m[1]}` : null
}
export function fmtDatePT(iso) {
  if (!iso) return ""
  if (dateOnly(iso)) return dateOnly(iso)
  return new Intl.DateTimeFormat("en-US", { timeZone: env.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso))
}
export function fmtTsPT(iso) {
  if (!iso) return "—"
  return new Intl.DateTimeFormat("en-US", { timeZone: env.tz, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(iso))
}
export function fmtLongDatePT(iso) {
  if (!iso) return ""
  if (dateOnly(iso)) iso = `${iso}T12:00:00-07:00`
  return new Intl.DateTimeFormat("en-US", { timeZone: env.tz, year: "numeric", month: "long", day: "numeric" }).format(new Date(iso))
}

// ---------------------------------------------------------------- drawing helpers

function wrap(font, size, text, maxW) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ""
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w
    if (font.widthOfTextAtSize(t, size) <= maxW) cur = t
    else {
      if (cur) lines.push(cur)
      // very long token (hash, url): hard-split
      if (font.widthOfTextAtSize(w, size) > maxW) {
        let chunk = ""
        for (const ch of w) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxW) { lines.push(chunk); chunk = ch } else chunk += ch
        }
        cur = chunk
      } else cur = w
    }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : [""]
}

/** Draws one signer's signature (drawn PNG or script text) with its bottom on `baseY`. */
async function drawSignature(doc, page, fonts, signer, { x, baseY, maxW, maxH }) {
  if (signer.signature_method === "drawn" && signer.signature_png) {
    const png = await doc.embedPng(signer.signature_png)
    const scale = Math.min(maxW / png.width, maxH / png.height, 1.5)
    const w = png.width * scale, h = png.height * scale
    page.drawImage(png, { x, y: baseY, width: w, height: h })
    return
  }
  const name = signer.typed_name || signer.name
  const sf = await scriptFontFor(doc, fonts, signer)
  let size = Math.min(sf.size, maxH)
  const w1 = sf.font.widthOfTextAtSize(name, 1)
  if (w1 * size > maxW) size = Math.max(9, maxW / w1)
  page.drawText(name, { x: x + 2, y: baseY + 3, size, font: sf.font, color: rgb(0.1, 0.1, 0.35) })
}

function stampText(page, fonts, signer, envelopeId, { x, y, w }) {
  const t = `e-signed ${fmtTsPT(signer.signed_at)} · ${envelopeId.slice(0, 8)}`
  const size = 5.5
  const tw = fonts.helv.widthOfTextAtSize(t, size)
  page.drawText(t, { x: x + w - tw, y, size, font: fonts.helv, color: rgb(0.45, 0.45, 0.45) })
}

// ---------------------------------------------------------------- assembly

function roleLabel(s) { return s.role === "buyer" ? "Buyer" : "Seller" }

async function loadForDrawing(originalBytes, title) {
  const doc = await PDFDocument.load(originalBytes, { updateMetadata: false })
  doc.registerFontkit(fontkit)
  const fonts = {
    helv: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  }
  doc.setTitle(title)
  doc.setProducer(`${env.businessName} e-sign`)
  doc.setModificationDate(new Date())
  return { doc, fonts }
}

/**
 * Everything the signers have done so far, drawn onto a loaded copy of the
 * original: the template's date fields and the addendum box, flatten, the
 * signatures on the agreement's own lines, the Signature Addendum page(s).
 * Shared by the interim build (after every signature — what later signers
 * review) and the final build (which then appends the certificate).
 * `signers` is every signer on the envelope; only the signed ones leave ink,
 * but the addendum box is ticked and the addendum page lists all addendum
 * signers so a reader can see whose signatures are still to come.
 */
async function applySignatures(doc, fonts, envelope, signers) {
  const signed = signers.filter((s) => s.status === "signed")
  const onTemplate = signed.filter((s) => s.placement === "template")
  const onAddendum = signers.filter((s) => s.placement === "addendum")
  let boxTicked = false

  // 1. Fill the date fields next to the template's signature lines (+ tick the addendum box), then flatten.
  let form = null
  try { form = doc.getForm() } catch { form = null }
  if (form) {
    if (envelope.is_template) {
      for (const s of onTemplate) {
        const fieldName = TEMPLATE.dateField[s.role]
        try {
          const f = form.getTextField(fieldName)
          if (f.getMaxLength() !== undefined) f.setMaxLength(undefined)
          f.setText(fmtDatePT(s.signed_at))
        } catch { /* field missing — nothing to date */ }
        if (s.role === "seller") {
          try {
            const f = form.getTextField("seller_signer_name")
            if (!f.getText()) f.setText(s.name)
          } catch { /* ignore */ }
        }
      }
      if (onAddendum.length) {
        try {
          form.getCheckBox(TEMPLATE.addendum.checkbox).check()
          boxTicked = true
        } catch { /* template predates the box (envelopes created before 2026-10-20) */ }
      }
    }
    try {
      for (const f of form.getFields()) { try { if (f.getMaxLength?.() !== undefined) f.setMaxLength(undefined) } catch { /* not a text field */ } }
      form.updateFieldAppearances(fonts.helv)
      form.acroForm.dict.delete(PDFName.of("NeedAppearances"))
      form.flatten()
    } catch (e) {
      console.warn("[esign] form flatten failed, leaving fields:", e?.message || e)
    }
  }

  // 2. Signatures on the agreement's own lines.
  if (envelope.is_template && onTemplate.length) {
    const page = doc.getPages()[TEMPLATE.page]
    for (const s of onTemplate) {
      const spot = TEMPLATE[s.role]
      if (!spot) continue
      await drawSignature(doc, page, fonts, s, { x: spot.x, baseY: spot.lineY + 2, maxW: 170, maxH: 26 })
      stampText(page, fonts, s, envelope.id, { x: spot.x, y: spot.lineY - 7.5, w: spot.w })
    }
  }

  // 3. Signature addendum for everyone else.
  if (onAddendum.length) await drawAddendum(doc, fonts, envelope, onAddendum, { referenced: boxTicked })
  return { boxTicked }
}

/**
 * The document as it stands: original + everyone who has signed so far, no
 * certificate. Written to envelopes/<id>/interim.pdf after every signature
 * and rendered to the page images later signers review. Returns the bytes
 * and the page count (original pages + addendum pages).
 */
export async function buildInterimPdf({ originalBytes, envelope, signers }) {
  const { doc, fonts } = await loadForDrawing(originalBytes, `${envelope.title} — in progress`)
  await applySignatures(doc, fonts, envelope, signers)
  const bytes = await doc.save({ useObjectStreams: false })
  return { bytes, pageCount: doc.getPageCount() }
}

/**
 * Build the signed document and the final (signed + certificate) document.
 * Returns { signedBytes, finalBytes, signedSha256, finalSha256 }.
 */
export async function buildFinalPdf({ originalBytes, envelope, signers, events }) {
  const { doc, fonts } = await loadForDrawing(originalBytes, `${envelope.title} — signed`)
  await applySignatures(doc, fonts, envelope, signers)

  const signedBytes = await doc.save({ useObjectStreams: false })
  const signedSha256 = sha256(signedBytes)

  // 4. Certificate of completion (appended to a copy so signed.pdf stays verifiable).
  const finalDoc = await PDFDocument.load(signedBytes, { updateMetadata: false })
  finalDoc.registerFontkit(fontkit)
  const ffonts = {
    helv: await finalDoc.embedFont(StandardFonts.Helvetica),
    bold: await finalDoc.embedFont(StandardFonts.HelveticaBold),
    mono: await finalDoc.embedFont(StandardFonts.Courier),
  }
  await drawCertificate(finalDoc, ffonts, envelope, signers, events, { signedSha256 })
  const finalBytes = await finalDoc.save({ useObjectStreams: false })
  return { signedBytes, finalBytes, signedSha256, finalSha256: sha256(finalBytes) }
}

/** Signature Addendum page(s): one block per addendum signer; a signer who hasn't signed yet gets an empty line. */
async function drawAddendum(doc, fonts, envelope, signers, { referenced = false } = {}) {
  const W = 612, H = 792, M = 54
  const logo = await embedLogo(doc)
  let page, y
  const newPage = () => {
    page = doc.addPage([W, H])
    y = H - M
    if (logo) { const h = 28, w = (logo.width / logo.height) * h; page.drawImage(logo, { x: W - M - w, y: y - h + 6, width: w, height: h }) }
    page.drawText("SIGNATURE ADDENDUM", { x: M, y: y - 14, size: 15, font: fonts.bold })
    y -= 34
  }
  newPage()
  const what = envelope.agreement_date
    ? `to the Real Estate Purchase & Sale Agreement dated ${fmtDatePT(envelope.agreement_date)}${envelope.property_address ? ` for the property at ${envelope.property_address}` : ""}`
    : `to: ${envelope.title}${envelope.property_address ? ` (${envelope.property_address})` : ""}`
  for (const line of wrap(fonts.helv, 10.5, what, W - 2 * M)) { page.drawText(line, { x: M, y, size: 10.5, font: fonts.helv }); y -= 14 }
  if (referenced) { page.drawText("Referenced by the checked box on page 2 of the Agreement.", { x: M, y, size: 9.5, font: fonts.helv, color: rgb(0.3, 0.3, 0.3) }); y -= 14 }
  y -= 6
  const body =
    `Each person signing below is a party to the above Agreement in the capacity shown, has reviewed the entire ` +
    `Agreement, and agrees to be bound by all of its terms as fully as if their signature appeared on the Agreement's ` +
    `signature page. The signatures below were applied electronically through ${env.businessName} e-sign and are ` +
    `recorded, with consent and audit details, in the Certificate of Completion attached to this document (envelope ${envelope.id}).`
  for (const line of wrap(fonts.helv, 9.5, body, W - 2 * M)) { page.drawText(line, { x: M, y, size: 9.5, font: fonts.helv, color: rgb(0.15, 0.15, 0.15) }) ; y -= 12.5 }
  y -= 18

  for (const s of signers) {
    if (y < M + 110) newPage()
    const signedHere = s.status === "signed"
    page.drawText(`${roleLabel(s)}:`, { x: M, y, size: 10, font: fonts.bold })
    const lineX = M + 90, lineW = 300, lineY = y - 26
    if (signedHere) await drawSignature(doc, page, fonts, s, { x: lineX, baseY: lineY + 2, maxW: 200, maxH: 28 })
    page.drawLine({ start: { x: lineX, y: lineY }, end: { x: lineX + lineW, y: lineY }, thickness: 0.7, color: rgb(0, 0, 0) })
    page.drawText("Signature", { x: lineX, y: lineY - 9, size: 6.5, font: fonts.helv, color: rgb(0.4, 0.4, 0.4) })
    if (signedHere) stampText(page, fonts, s, envelope.id, { x: lineX, y: lineY - 9, w: lineW })
    page.drawText(`Dated: ${signedHere ? fmtDatePT(s.signed_at) : "____________"}`, { x: lineX + lineW + 16, y: lineY + 4, size: 9.5, font: fonts.helv })
    page.drawText(`Name:  ${s.name}`, { x: lineX, y: lineY - 24, size: 9.5, font: fonts.helv })
    page.drawText(`Email:  ${s.email}${s.phone ? `     Tel:  ${s.phone}` : ""}`, { x: lineX, y: lineY - 38, size: 9.5, font: fonts.helv })
    y = lineY - 66
  }
  footer(page, fonts, `Signature Addendum · Envelope ${envelope.id}`)
}

async function drawCertificate(doc, fonts, envelope, signers, events, { signedSha256 }) {
  const W = 612, H = 792, M = 50
  const logo = await embedLogo(doc)
  let page, y, pageNo = 0
  const newPage = () => {
    pageNo++
    page = doc.addPage([W, H])
    y = H - M
    if (logo) { const h = 26, w = (logo.width / logo.height) * h; page.drawImage(logo, { x: W - M - w, y: y - h + 6, width: w, height: h }) }
    page.drawText("CERTIFICATE OF COMPLETION", { x: M, y: y - 14, size: 14, font: fonts.bold })
    page.drawText(`${env.businessName} e-sign · electronic signature record (ESIGN Act / California UETA)`, { x: M, y: y - 28, size: 8, font: fonts.helv, color: rgb(0.35, 0.35, 0.35) })
    y -= 48
    footer(page, fonts, `Certificate of Completion · Envelope ${envelope.id} · page ${pageNo}`)
  }
  const need = (h) => { if (y - h < M) newPage() }
  const kv = (k, v, { mono = false, size = 8.5 } = {}) => {
    const f = mono ? fonts.mono : fonts.helv
    const lines = wrap(f, size, v ?? "—", W - 2 * M - 120)
    need(lines.length * (size + 3) + 2)
    page.drawText(k, { x: M, y, size, font: fonts.bold })
    for (const line of lines) { page.drawText(line, { x: M + 120, y, size, font: f }); y -= size + 3 }
    y -= 2
  }
  const heading = (t) => { need(26); y -= 6; page.drawText(t, { x: M, y, size: 10.5, font: fonts.bold, color: rgb(0.1, 0.1, 0.35) }); y -= 16 }

  newPage()
  heading("Document")
  kv("Envelope ID", envelope.id, { mono: true })
  kv("Title", envelope.title)
  if (envelope.property_address) kv("Property", envelope.property_address)
  if (envelope.agreement_date) kv("Agreement date", fmtDatePT(envelope.agreement_date))
  kv("Pages (original)", String(envelope.page_count))
  kv("Status", envelope.status === "completed" ? `Completed · ${fmtTsPT(envelope.completed_at)}` : envelope.status)
  kv("Sent by", `${env.ownerName}, ${env.businessName} · ${env.senderEmail}`)
  kv("Created", fmtTsPT(envelope.created_at))
  heading("Document fingerprints (SHA-256)")
  kv("Original document", envelope.original_sha256, { mono: true, size: 7.5 })
  kv("Signed document", signedSha256, { mono: true, size: 7.5 })
  {
    const note = "The original fingerprint is the document exactly as sent to the signers. The signed fingerprint is the document with every signature and addendum applied, before this certificate was appended; the sender keeps that file. Any change to either file changes its fingerprint."
    const lines = wrap(fonts.helv, 7.5, note, W - 2 * M)
    need(lines.length * 10)
    for (const line of lines) { page.drawText(line, { x: M, y, size: 7.5, font: fonts.helv, color: rgb(0.3, 0.3, 0.3) }); y -= 10 }
  }

  heading("Signers")
  for (const s of signers) {
    need(120)
    page.drawText(`${s.name}  —  ${s.role === "buyer" ? "Buyer" : "Seller"} (signing order ${s.order_index})`, { x: M, y, size: 9.5, font: fonts.bold }); y -= 13
    kv("Email / phone", [s.email, s.phone].filter(Boolean).join("  ·  ") || "—")
    kv("Status", s.status === "signed" ? "Signed" : s.status)
    kv("Sent", s.sent_at ? `${fmtTsPT(s.sent_at)} by ${s.delivery === "both" ? "email and text message" : s.delivery === "text" ? "text message" : "email"}${s.send_count > 1 ? ` (${s.send_count} sends)` : ""}` : "—")
    kv("Opened", s.opened_at ? `${fmtTsPT(s.opened_at)} · IP ${s.open_ip ?? "?"} · ${geoLabel(s.open_geo)} · ${deviceLabel(s.open_ua)}` : "—")
    kv("Consent", s.consented_at ? `${fmtTsPT(s.consented_at)} · agreed to electronic records and signatures (consent text v${s.consent_version}) · IP ${s.consent_ip ?? "?"}` : "—")
    kv("Signed", s.signed_at ? `${fmtTsPT(s.signed_at)} · IP ${s.sign_ip ?? "?"} · ${geoLabel(s.sign_geo)} · ${deviceLabel(s.sign_ua)}` : "—")
    if (s.signed_at) {
      kv("Signature", `${s.signature_method === "drawn" ? "Drawn on screen with finger/stylus" : `Typed (style: ${SIGNATURE_FONTS[fontKey(s.signature_font)].label})`} · legal name typed: "${s.typed_name}" · placed on ${s.placement === "template" ? "the agreement's signature line" : "the Signature Addendum"}`)
      kv("Intent", `Clicked "I agree and sign" after reviewing all ${envelope.page_count} pages`)
    }
    kv("SMS verification", s.sms_verified ? "Passed" : "Not requested")
    y -= 4
  }

  heading("Event log (all times " + env.tz + ")")
  const cols = [M, M + 118, M + 230, M + 400]
  need(14)
  page.drawText("Time", { x: cols[0], y, size: 7.5, font: fonts.bold })
  page.drawText("Event", { x: cols[1], y, size: 7.5, font: fonts.bold })
  page.drawText("Who", { x: cols[2], y, size: 7.5, font: fonts.bold })
  page.drawText("IP · location", { x: cols[3], y, size: 7.5, font: fonts.bold })
  y -= 11
  const byId = Object.fromEntries(signers.map((s) => [s.id, s]))
  for (const e of events) {
    need(11)
    const who = e.signer_id ? byId[e.signer_id]?.name ?? "" : env.ownerName
    page.drawText(fmtTsPT(e.at), { x: cols[0], y, size: 7, font: fonts.helv })
    page.drawText(String(e.kind).replace(/_/g, " "), { x: cols[1], y, size: 7, font: fonts.helv })
    page.drawText(who.slice(0, 32), { x: cols[2], y, size: 7, font: fonts.helv })
    page.drawText(`${e.ip ?? ""}${e.geo ? ` · ${geoLabel(e.geo)}` : ""}`.slice(0, 48), { x: cols[3], y, size: 7, font: fonts.helv })
    y -= 10
  }
  y -= 8
  const legal = `Each signer consented to do business electronically before viewing the document (consent text v${CONSENT_VERSION}), reviewed every page, typed their legal name and clicked "I agree and sign". The signatures were applied by ${env.businessName} e-sign at ${env.baseUrl} and the records above are retained by ${env.businessName}.`
  const lines = wrap(fonts.helv, 7.5, legal, W - 2 * M)
  need(lines.length * 10)
  for (const line of lines) { page.drawText(line, { x: M, y, size: 7.5, font: fonts.helv, color: rgb(0.3, 0.3, 0.3) }); y -= 10 }
}

function footer(page, fonts, text) {
  page.drawText(text, { x: 50, y: 28, size: 7, font: fonts.helv, color: rgb(0.5, 0.5, 0.5) })
}

let logoCache
async function embedLogo(doc) {
  try {
    if (logoCache === undefined) {
      const p = path.join(APP_ROOT, "public", "logo.png")
      logoCache = fs.existsSync(p) ? fs.readFileSync(p) : null
    }
    return logoCache ? await doc.embedPng(logoCache) : null
  } catch { return null }
}
