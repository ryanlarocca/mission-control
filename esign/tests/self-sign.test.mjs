// Self-sign: Ryan signing a form someone else sent, on the form's own lines.
// No server, no Google: a temp data dir, dry mail/Telegram and the in-memory
// Drive (ESIGN_DRY_DRIVE). Three forms — a typed one like Maryam's access
// acknowledgment, a scan (image only, no text layer) and a two-page form with
// initials on page 1 and drawn signature lines.
//
//   cd esign && node --test tests/self-sign.test.mjs
import { test, before } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "esign-self-"))
Object.assign(process.env, {
  ESIGN_DATA_DIR: dataDir, ESIGN_DRY_MAIL: "1", ESIGN_QUIET: "1", ESIGN_DRY_DRIVE: "1",
  ESIGN_BASE_URL: "http://127.0.0.1:1", ESIGN_DRIVE_ROOT_ID: "root",
})
const E = await import("../lib/envelope.mjs")
const D = await import("../lib/db.mjs")
const ctx = { ip: "127.0.0.1", ua: "node-test", geo: null, geoLabel: "test", device: "test" }
const bin = (n) => (fs.existsSync(`/opt/homebrew/bin/${n}`) ? `/opt/homebrew/bin/${n}` : n)
const text = (file) => execFileSync(bin("pdftotext"), ["-layout", file, "-"], { encoding: "utf8" })
const blanks = (file) => JSON.parse(execFileSync(process.execPath, [path.join(ROOT, "scripts/find-blanks.mjs"), file], { encoding: "utf8" })).pages
const write = (name, bytes) => { const f = path.join(dataDir, name); fs.writeFileSync(f, bytes); return f }
const todayPT = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())

/** Dark pixels in a PDF-point rectangle of page `n` (rendered at 72 dpi as PGM). */
function dark(file, n, { x, y, w, h }) {
  const prefix = path.join(dataDir, `px${Math.random().toString(36).slice(2, 8)}`)
  execFileSync(bin("pdftoppm"), ["-r", "72", "-gray", "-f", String(n), "-l", String(n), file, prefix])
  const pgm = fs.readdirSync(dataDir).find((f) => f.startsWith(path.basename(prefix)))
  const b = fs.readFileSync(path.join(dataDir, pgm))
  const m = /P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(b.toString("latin1", 0, 40))
  const W = +m[1], H = +m[2], off = m[0].length
  let c = 0
  for (let yy = Math.round(H - y - h); yy < Math.round(H - y); yy++) for (let xx = Math.round(x); xx < Math.round(x + w); xx++) if (b[off + yy * W + xx] < 128) c++
  return c
}

async function typedForm() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const f = await doc.embedFont(StandardFonts.TimesRoman)
  page.drawText("1234 TEST COURT ACCESS ACKNOWLEDGMENT", { x: 150, y: 720, size: 13, font: f })
  page.drawText("The undersigned releases the Owners from any liability with respect thereto.", { x: 72, y: 680, size: 11, font: f })
  page.drawText("Prospective Buyer:", { x: 128, y: 380, size: 12, font: f })
  ;[["Name:", 350], ["Company:", 322], ["Date:", 294], ["Signature:", 266]].forEach(([l, y]) =>
    page.drawText(`${l} ${"_".repeat(26)}`, { x: 72, y, size: 12, font: f }))
  return Buffer.from(await doc.save())
}

/** Signs envelope `id` the way the server routes do: consent, then sign. */
async function sign(id, opts = {}) {
  const env = D.getEnvelope(id)
  const signer = D.getSigners(id)[0]
  await E.recordConsent(signer, env, ctx)
  await E.recordSign(D.getSigner(signer.id), D.getEnvelope(id), { typedName: "Ryan LaRocca", method: "typed", font: "greatvibes", ...opts }, ctx)
  return D.getEnvelope(id)
}

const dry = () => globalThis.__dryDrive
const pathOf = (file) => { const out = []; let p = file.parent; while (p && p !== "root") { const f = dry().files.find((x) => x.id === p); out.unshift(f.name); p = f.parent } return out.join("/") }

let typedPdf
before(async () => { typedPdf = write("typed.pdf", await typedForm()) })

test("find-blanks: typed form — four labelled lines", () => {
  const [p] = blanks(typedPdf)
  assert.equal(p.textLayer, true)
  assert.deepEqual(p.blanks.map((b) => b.label), ["Name:", "Company:", "Date:", "Signature:"])
  for (const [b, y] of p.blanks.map((b, i) => [b, [350, 322, 294, 266][i]])) {
    assert.ok(b.lineY < y && b.lineY > y - 4, `line for ${b.label} sits just under the text baseline (got ${b.lineY})`)
    assert.ok(b.w > 100)
  }
})

test("self-sign: typed form → fill-ins in the review, signature + date on the lines, three files filed, share = clean copy only", async () => {
  const [p] = blanks(typedPdf)
  const at = (label) => p.blanks.find((b) => b.label === label)
  const fields = [
    { page: 1, kind: "text", value: "Ryan LaRocca", label: "Name", ...at("Name:") },
    { page: 1, kind: "text", value: "LRG Homes", label: "Company", ...at("Company:") },
    { page: 1, kind: "date", label: "Date", ...at("Date:") },
    { page: 1, kind: "signature", label: "Signature", ...at("Signature:") },
  ]
  const r = await E.createSelfSign({ pdfBytes: fs.readFileSync(typedPdf), docLabel: "Access Acknowledgment", street: "1234 Test Ct", propertyAddress: "1234 Test Ct, San Jose, CA", receivedFrom: "Test Niece", fields })
  assert.match(r.link, /\/s\/[A-Za-z0-9_-]{20,}$/)
  assert.match(r.filingFolder, /^E-Sign\/Signed by Ryan\/\d{4}-\d{2}-\d{2} · 1234 Test Ct · Access Acknowledgment$/)
  const env0 = D.getEnvelope(r.id)
  assert.equal(env0.kind, "self")
  assert.equal(D.getSigners(r.id).length, 1)
  assert.equal(D.getSigners(r.id)[0].placement, "fields")
  assert.equal(D.getSigners(r.id)[0].status, "sent", "a link exists, nothing was emailed")

  // What Ryan reviews = the fill-ins + today's date, no signature yet; the sender's form is kept untouched.
  const interim = E.interimPath(env0)
  assert.ok(interim, "interim build exists before anyone signs")
  const t0 = text(interim)
  assert.match(t0, /Name:\s+Ryan LaRocca/)
  assert.match(t0, /Company:\s+LRG Homes/)
  assert.ok(t0.includes(todayPT), "today's date on the Date line")
  assert.ok(!text(env0.source_path).includes("Ryan LaRocca"), "source.pdf is the form as received")
  assert.ok(fs.existsSync(path.join(E.envelopeDir(r.id), "pages", "page-1.png")))
  const sig = at("Signature:")
  const sigBox = { x: sig.x, y: sig.lineY + 2, w: 120, h: 18 }
  assert.ok(dark(interim, 1, sigBox) < 5, "signature line is empty before signing")

  const env1 = await sign(r.id)
  assert.equal(env1.status, "completed")
  const dir = E.envelopeDir(r.id)
  const signed = path.join(dir, "signed.pdf"), final = path.join(dir, "final.pdf")
  assert.ok(dark(signed, 1, sigBox) > 40, "signature ink sits on the Signature line")
  const ts = text(signed)
  assert.match(ts, /Name:\s+Ryan LaRocca/)
  assert.ok(ts.includes(todayPT))
  assert.ok(!/CERTIFICATE OF COMPLETION/.test(ts), "clean copy has no certificate")
  assert.ok(!/127\.0\.0\.1/.test(ts), "clean copy carries no IP")
  const tf = text(final)
  assert.match(tf, /CERTIFICATE OF COMPLETION/)
  assert.match(tf, /Form as received/)
  assert.match(tf, /document's own signature\s+line/)
  assert.match(tf, /form\s+from Test Niece/)

  const filed = dry().files.filter((f) => f.mimeType === "application/pdf")
  assert.deepEqual(filed.map((f) => f.name).sort(), ["Access Acknowledgment - original.pdf", "Access Acknowledgment - signed + certificate.pdf", "Access Acknowledgment - signed.pdf"])
  for (const f of filed) assert.equal(pathOf(f), r.filingFolder)
  assert.equal(filed.find((f) => f.name.endsWith("original.pdf")).bytes.equals(fs.readFileSync(typedPdf)), true)
  const env2 = D.getEnvelope(r.id)
  assert.ok(env2.drive_folder_link && env2.drive_signed_link && env2.drive_final_link)

  // A second delivery run (retry) must not file duplicates.
  await E.deliver(r.id)
  assert.equal(dry().files.filter((f) => f.mimeType === "application/pdf").length, 3)

  const share = await E.shareSigned(r.id, "Niece@Example.com")
  assert.equal(share.link, env2.drive_signed_link)
  assert.deepEqual(dry().permissions, [{ fileId: env2.drive_signed_id, type: "user", role: "reader", emailAddress: "niece@example.com", sendNotificationEmail: false }])
})

test("self-sign: bad field specs are refused before anything is created", async () => {
  const bytes = fs.readFileSync(typedPdf)
  const before = D.listEnvelopes().length
  await assert.rejects(E.createSelfSign({ pdfBytes: bytes, docLabel: "X", fields: [{ page: 1, kind: "text", value: "a", x: 72, lineY: 300, w: 100 }] }), /signature field/)
  await assert.rejects(E.createSelfSign({ pdfBytes: bytes, docLabel: "X", fields: [{ page: 2, kind: "signature", x: 72, lineY: 300, w: 100 }] }), /page 2 is not in the document/)
  await assert.rejects(E.createSelfSign({ pdfBytes: bytes, docLabel: "X", fields: [{ page: 1, kind: "signature", x: 580, lineY: 300, w: 100 }] }), /off the page/)
  await assert.rejects(E.createSelfSign({ pdfBytes: bytes, docLabel: "X", fields: [{ page: 1, kind: "signature", x: 72, lineY: 300, w: 100 }, { page: 1, kind: "text", value: " ", x: 72, lineY: 330, w: 100 }] }), /needs a value/)
  assert.equal(D.listEnvelopes().length, before)
})

test("find-blanks: scanned form (image only) — lines found from the page image", async () => {
  const prefix = path.join(dataDir, "scan")
  execFileSync(bin("pdftoppm"), ["-r", "150", "-png", "-singlefile", typedPdf, prefix])
  const doc = await PDFDocument.create()
  const img = await doc.embedPng(fs.readFileSync(`${prefix}.png`))
  doc.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 })
  const scan = write("scan.pdf", Buffer.from(await doc.save()))
  const [p] = blanks(scan)
  assert.equal(p.textLayer, false)
  assert.equal(p.blanks.length, 4)
  assert.ok(p.blanks.every((b) => b.source === "drawn" && b.label === null))
  const typed = blanks(typedPdf)[0].blanks
  p.blanks.forEach((b, i) => assert.ok(Math.abs(b.lineY - typed[i].lineY) < 2.5, `scan line ${i + 1} at ${b.lineY} vs typed ${typed[i].lineY}`))
})

test("self-sign: two pages, initials on page 1 + drawn lines with captions on page 2 — every signature field gets ink", async () => {
  const doc = await PDFDocument.create()
  const f = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([612, 792]), p2 = doc.addPage([612, 792])
  p1.drawText("Page one terms.", { x: 72, y: 700, size: 11, font: f })
  p1.drawText("Initials: ________", { x: 450, y: 60, size: 11, font: f })
  for (const [x, cap] of [[72, "Signature"], [340, "Date"]]) {
    p2.drawLine({ start: { x, y: 300 }, end: { x: x + 200, y: 300 }, thickness: 0.8, color: rgb(0, 0, 0) })
    p2.drawText(cap, { x, y: 290, size: 8, font: f })
  }
  const form = write("two-page.pdf", Buffer.from(await doc.save()))
  const pages = blanks(form)
  const ini = pages[0].blanks[0]
  assert.equal(ini.label, "Initials:")
  assert.deepEqual(pages[1].blanks.map((b) => [b.label, b.source]), [["Signature", "drawn"], ["Date", "drawn"]])
  const [sl, dl] = pages[1].blanks
  const r = await E.createSelfSign({ pdfBytes: fs.readFileSync(form), docLabel: "Two Page", fields: [
    { page: 1, kind: "signature", label: "Initials", ...ini },
    { page: 2, kind: "signature", label: "Signature", ...sl },
    { page: 2, kind: "date", label: "Date", ...dl },
  ] })
  assert.match(r.filingFolder, /^E-Sign\/Signed by Ryan\/\d{4}-\d{2}-\d{2} · Two Page$/)
  const env = await sign(r.id, { method: "drawn", signaturePng: `data:image/png;base64,${fs.readFileSync(path.join(ROOT, "public", "logo.png")).toString("base64")}` })
  assert.equal(env.status, "completed")
  const signed = path.join(E.envelopeDir(r.id), "signed.pdf")
  assert.ok(dark(signed, 1, { x: ini.x, y: ini.lineY + 2, w: Math.min(ini.w, 60), h: 16 }) > 20, "initials ink on page 1")
  assert.ok(dark(signed, 2, { x: sl.x, y: sl.lineY + 2, w: 150, h: 20 }) > 20, "signature ink on page 2")
  assert.ok(text(signed).includes(todayPT))
})
