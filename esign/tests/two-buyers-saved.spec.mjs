// Two buyers + two sellers sign on the agreement itself (no Signature Addendum),
// and a returning signer signs a later document in one tap (2026-11-17).
//
//   cd esign && node --test tests/two-buyers-saved.spec.mjs     (also run by npm run test:e2e)
//
// Boots a dry server on a temp data dir; envelopes are created and the first
// signatures recorded in-process against the same DB, and the returning
// signer's one tap is driven on iPhone emulation.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, devices } from "playwright"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TEMPLATE_PDF = path.join(ROOT, "assets", "template-reference.pdf")
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)) }).on("error", rej)
})
const waitFor = async (fn, what, ms = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error(`timed out waiting for ${what}`)
}
const pdfText = (file, pageNo) => execFileSync("pdftotext", ["-layout", ...(pageNo ? ["-f", String(pageNo), "-l", String(pageNo)] : []), file, "-"], { encoding: "utf8" })
const pageCount = (file) => Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [file], { encoding: "utf8" }))[1])

let server, base, dataDir, browser, ctx, E, db
let stdout = ""
const CTX = { ip: "127.0.0.1", ua: "test", geo: null, geoLabel: "test", device: "test" }
const signerRow = (envId, name) => db.prepare("SELECT * FROM signers WHERE envelope_id = ? AND name = ?").get(envId, name)
async function signInProcess(envId, name, font = "allura") {
  const s = signerRow(envId, name)
  await E.recordConsent(s, E.getEnvelope ? E.getEnvelope(envId) : db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envId), CTX)
  const envl = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envId)
  await E.recordSign(signerRow(envId, name), envl, { typedName: name, method: "typed", font }, CTX)
}

before(async () => {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "esign-2b-"))
  const env = {
    ESIGN_PORT: String(port), ESIGN_BASE_URL: base, ESIGN_DATA_DIR: dataDir,
    ESIGN_DRY_MAIL: "1", ESIGN_QUIET: "1", ESIGN_DRY_DRIVE: "1", ESIGN_DRY_CRM: "1",
    ESIGN_ADMIN_PASSWORD: "t", ESIGN_API_SECRET: "t", ESIGN_COOKIE_SECRET: "t",
  }
  Object.assign(process.env, env)
  E = await import("../lib/envelope.mjs")
  db = (await import("../lib/db.mjs")).getDb()
  server = spawn(process.execPath, ["server.mjs"], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
  server.stdout.on("data", (d) => { stdout += d })
  server.stderr.on("data", (d) => { if (!/ExperimentalWarning|trace-warnings/.test(String(d))) process.stderr.write(d) })
  await waitFor(() => /listening on/.test(stdout), "server to boot")
  browser = await chromium.launch()
  ctx = await browser.newContext({ ...devices["iPhone 13"] })
}, { timeout: 60000 })

after(async () => {
  await browser?.close()
  server?.kill()
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
})

let firstEnv
test("two buyers and two sellers all get a line on the agreement", async () => {
  const { id } = await E.createEnvelope({
    title: "TEST Two buyers – 9 Test Ct", propertyAddress: "9 Test Ct, San Jose, CA", pdfBytes: fs.readFileSync(TEMPLATE_PDF), createdBy: "test",
    signers: [
      { name: "Ryan LaRocca", email: "ryan@example.com", role: "buyer", order: 1 },
      { name: "Adam Oback", email: "adam@example.com", role: "buyer", order: 2 },
      { name: "Margaret Thompson", email: "margaret@example.com", role: "seller", order: 2 },
      { name: "Harold Thompson", email: "harold@example.com", role: "seller", order: 2 },
    ],
  })
  firstEnv = id
  const placement = Object.fromEntries(db.prepare("SELECT name, placement FROM signers WHERE envelope_id = ?").all(id).map((r) => [r.name, r.placement]))
  assert.deepEqual(placement, { "Ryan LaRocca": "template", "Adam Oback": "template_buyer2", "Margaret Thompson": "template", "Harold Thompson": "template2" })
})

test("all four sign: the agreement stays 2 pages + certificate, no Signature Addendum, every date and the second buyer's name filled", async () => {
  for (const name of ["Ryan LaRocca", "Adam Oback", "Margaret Thompson", "Harold Thompson"]) await signInProcess(firstEnv, name)
  const envl = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(firstEnv)
  assert.equal(envl.status, "completed")
  const signed = path.join(dataDir, "envelopes", firstEnv, "signed.pdf")
  assert.equal(pageCount(signed), 2, "signed copy is just the 2-page agreement")
  const final = path.join(dataDir, "envelopes", firstEnv, "final.pdf")
  assert.ok(!/Signature Addendum ·/.test(pdfText(final)), "no Signature Addendum page")
  const p2 = pdfText(signed, 2)
  const dates = p2.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) || []
  assert.ok(dates.length >= 4, `four signing dates on page 2 (found ${dates.length})`)
  assert.match(p2, /Adam Oback/, "second buyer's name filled")
  assert.match(p2, /Harold Thompson/, "second seller's name filled")
  assert.match(p2, /Margaret Thompson/, "first seller's name filled")
  for (const name of ["Ryan LaRocca", "Adam Oback", "Margaret Thompson", "Harold Thompson"]) {
    assert.match(pdfText(final), new RegExp(`${name}[^\\n]*\\n?[^\\n]*`), `${name} is on the certificate`)
  }
})

test("a returning signer sees their saved signature and signs in one tap", async () => {
  const { id } = await E.createEnvelope({
    title: "TEST Returning – 10 Test Ct", propertyAddress: "10 Test Ct, San Jose, CA", pdfBytes: fs.readFileSync(TEMPLATE_PDF), createdBy: "test",
    signers: [
      { name: "Adam Oback", email: "ADAM@example.com", role: "buyer", order: 1 },
      { name: "New Person", email: "new@example.com", role: "seller", order: 2 },
    ],
  })
  const adam = signerRow(id, "Adam Oback")
  const saved = E.savedSignatureFor(adam)
  assert.deepEqual({ name: saved.typedName, method: saved.method, font: saved.font }, { name: "Adam Oback", method: "typed", font: "allura" }, "matched by email, case-insensitive")
  assert.equal(E.savedSignatureFor(signerRow(id, "New Person")), null, "a first-time signer has no saved signature")

  const { link } = await E.freshLink(id, adam.id)
  const page = await ctx.newPage()
  page.on("pageerror", (e) => { throw e })
  await page.goto(link)
  await page.check("#cagree")
  await Promise.all([page.waitForURL(link), page.locator("form[action$='/consent'] button[type=submit]").click()])
  await page.locator("#savedcard").waitFor()
  assert.match(await page.locator("#savedcard h2").innerText(), /Welcome back, Adam/)
  assert.ok(await page.locator("#finishcard").isHidden(), "the regular Finish card is out of the way")
  await Promise.all([page.waitForLoadState("networkidle"), page.locator("#onetap").click()])
  await page.getByText("you're done").waitFor()
  const row = signerRow(id, "Adam Oback")
  assert.equal(row.status, "signed")
  assert.equal(row.typed_name, "Adam Oback")
  assert.equal(row.signature_font, "allura", "same style as last time")
  const ev = db.prepare("SELECT details FROM events WHERE envelope_id = ? AND kind = 'signed' AND signer_id = ?").get(id, row.id)
  assert.equal(JSON.parse(ev.details).reusedSavedSignature, true, "the audit trail records the reused signature")
  await page.close()
})

test("'Use a different signature' falls back to the normal sheet, and a first-time signer gets the normal flow", async () => {
  const { id } = await E.createEnvelope({
    title: "TEST Different – 11 Test Ct", pdfBytes: fs.readFileSync(TEMPLATE_PDF), createdBy: "test",
    signers: [{ name: "Ryan LaRocca", email: "ryan@example.com", role: "buyer", order: 1 }, { name: "Fresh Seller", email: "fresh@example.com", role: "seller", order: 2 }],
  })
  const ryan = signerRow(id, "Ryan LaRocca")
  const { link } = await E.freshLink(id, ryan.id)
  const page = await ctx.newPage()
  page.on("pageerror", (e) => { throw e })
  await page.goto(link)
  await page.check("#cagree")
  await Promise.all([page.waitForURL(link), page.locator("form[action$='/consent'] button[type=submit]").click()])
  await page.locator("#usedifferent").click()
  assert.ok(await page.locator("#savedcard").isHidden())
  assert.ok(await page.locator("#finishcard").isVisible())
  await page.locator("#signtab").click()
  assert.equal(await page.locator("#typed_name").inputValue(), "Ryan LaRocca", "the sheet is prefilled with the saved name")
  await page.close()

  const fresh = signerRow(id, "Fresh Seller")
  // The seller isn't invited until Ryan signs; a fresh link still renders the normal (no saved card) page once consented.
  const { link: l2 } = await E.freshLink(id, fresh.id)
  const p2 = await ctx.newPage()
  await p2.goto(l2)
  await p2.check("#cagree")
  await Promise.all([p2.waitForURL(l2), p2.locator("form[action$='/consent'] button[type=submit]").click()])
  assert.equal(await p2.locator("#savedcard").count(), 0, "no saved card for a first-time signer")
  assert.ok(await p2.locator("#finishcard").isVisible())
  await p2.close()
})
