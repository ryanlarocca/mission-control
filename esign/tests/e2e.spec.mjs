// End-to-end: boots a dry server (no Google / Telegram / sidecar) on a free
// port with a temp data dir, then drives the whole flow on iPhone emulation:
// admin upload → two sellers (typed + drawn) → buyer invited only after both
// → completion → final.pdf → verify page.
//
//   cd esign && npm run test:e2e        (node --test tests/e2e.spec.mjs)
//
// Needs Node ≥ 22.5, pdftoppm on PATH and Playwright's Chromium.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { chromium, devices } from "playwright"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TEMPLATE_PDF = path.join(ROOT, "assets", "template-reference.pdf")
const PASSWORD = "e2e-pass"

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)) }).on("error", rej)
})

let server, base, dataDir, browser, ctx, page
let stdout = ""
const links = () => [...new Set([...stdout.matchAll(/https?:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{20,}/g)].map((m) => m[0]))]
const waitFor = async (fn, what, ms = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error(`timed out waiting for ${what}`)
}

before(async () => {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "esign-e2e-"))
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env, ESIGN_PORT: String(port), ESIGN_BASE_URL: base, ESIGN_DATA_DIR: dataDir,
      ESIGN_DRY_MAIL: "1", ESIGN_QUIET: "1", ESIGN_ADMIN_PASSWORD: PASSWORD, ESIGN_API_SECRET: "e2e-api", ESIGN_COOKIE_SECRET: "e2e-cookie",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", (d) => { stdout += d })
  server.stderr.on("data", (d) => { if (!/ExperimentalWarning|trace-warnings/.test(String(d))) process.stderr.write(d) })
  await waitFor(() => /listening on/.test(stdout), "server to boot")
  browser = await chromium.launch()
  ctx = await browser.newContext({ ...devices["iPhone 13"] })
  page = await ctx.newPage()
  page.on("pageerror", (e) => { throw e })
}, { timeout: 60000 })

after(async () => {
  await browser?.close()
  server?.kill()
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
})

let envelopeId, sellerLinks, buyerLink

test("static assets are content-hashed and cached immutably only when the hash matches", async () => {
  const html = await (await fetch(`${base}/admin/login`)).text()
  const m = /\/style\.css\?v=([0-9a-f]{12})/.exec(html)
  assert.ok(m, "layout links a versioned stylesheet")
  const fresh = await fetch(`${base}/style.css?v=${m[1]}`)
  assert.equal(fresh.headers.get("cache-control"), "public, max-age=31536000, immutable")
  assert.equal((await fetch(`${base}/style.css`)).headers.get("cache-control"), "no-cache")
  assert.equal((await fetch(`${base}/style.css?v=stale`)).headers.get("cache-control"), "no-cache")
  assert.equal((await fetch(`${base}/logo-email.png`)).headers.get("content-type"), "image/png")
  assert.equal((await fetch(`${base}/fonts/Allura-Regular.ttf`)).headers.get("content-type"), "font/ttf")
})

test("admin creates a request by uploading the template with three signers", async () => {
  await page.goto(`${base}/admin/login`)
  await page.fill("input[name=password]", PASSWORD)
  await page.click("button[type=submit]")
  await page.waitForURL(`${base}/admin`)
  await page.goto(`${base}/admin/new`)
  await page.check("input[name=source][value=upload]")
  await page.setInputFiles("input[name=pdf]", TEMPLATE_PDF)
  await page.fill("#title", "Purchase Agreement – 123 Test St")
  await page.fill("#property_address", "123 Test St, San Jose, CA")
  await page.fill("input[name=agreement_date]", "2026-10-18")
  const names = page.locator('[name="s_name[]"]'), emails = page.locator('[name="s_email[]"]')
  await names.nth(0).fill("Margaret Ann Thompson"); await emails.nth(0).fill("margaret@example.com")
  await page.click("#addsigner")
  await names.nth(1).fill("Harold Thompson"); await emails.nth(1).fill("harold@example.com")
  await page.click("#addsigner")
  await names.nth(2).fill("Ryan LaRocca"); await emails.nth(2).fill("ryan@lrghomes.com")
  await page.locator('[name="s_role[]"]').nth(2).selectOption("buyer")
  await page.locator('[name="s_order[]"]').nth(2).selectOption("2")
  await page.click("#newform button[type=submit]")
  await page.waitForURL(/\/admin\/e\/[0-9a-f]{16}/)
  envelopeId = /\/admin\/e\/([0-9a-f]{16})/.exec(page.url())[1]
  const text = await page.locator("main").innerText()
  assert.match(text, /Sent to Margaret Ann Thompson, Harold Thompson/)
  assert.match(text, /LRG purchase agreement template/)
  assert.match(text, /Harold Thompson[\s\S]*on the addendum/)
  assert.match(text, /Ryan LaRocca[\s\S]*waiting/)
  sellerLinks = await waitFor(() => { const l = links(); return l.length === 2 ? l : null }, "two invitation links")
  assert.equal((await page.evaluate(() => document.documentElement.scrollWidth)), 390, "no horizontal scroll on the admin page")
})

async function consent(link) {
  await page.goto(link)
  assert.match(await page.locator("h1").innerText(), /sent you a document to sign/)
  await page.check("#cagree")
  await page.click("#consentform button[type=submit]")
  await page.waitForURL(link)
  await page.waitForLoadState("networkidle")
}

test("seller 1 consents, then types a signature in a non-default style on the seller line", async () => {
  await consent(sellerLinks[0])
  assert.match(await page.locator("h1").innerText(), /Purchase Agreement/)
  const tab = page.locator("#signtab")
  await tab.scrollIntoViewIfNeeded()
  const t = await tab.boundingBox(), p2 = await page.locator(".pagewrap").nth(1).boundingBox()
  assert.ok(t.height >= 44, `tab is a comfortable tap target (${t.height}px)`)
  const lineY = p2.y + p2.height * ((792 - 201) / 792) // TEMPLATE.seller.lineY
  assert.ok(Math.abs(t.y + t.height - lineY) <= 2.5, `tab bottom (${t.y + t.height}) sits on the seller line (${lineY})`)
  assert.ok(Math.abs(t.x - (p2.x + p2.width * (309 / 612))) <= 2.5, "tab starts at the line's left edge")
  assert.ok(await page.locator("#finish").isDisabled(), "Finish is disabled before signing")
  await tab.click()
  await page.fill("#typed_name", "Margaret")
  await page.click("#adopt")
  assert.ok(await page.locator("#sheeterr").isVisible(), "single-word name is rejected")
  await page.fill("#typed_name", "Margaret Ann Thompson")
  await page.check("input[name=fontpick][value=allura]")
  await page.click("#adopt")
  await page.waitForTimeout(400)
  assert.ok(await page.locator("#sheet").isHidden(), "sheet closes after adopt")
  const span = page.locator("#sigpreview span")
  assert.equal(await span.innerText(), "Margaret Ann Thompson")
  assert.match(await span.evaluate((e) => e.style.fontFamily), /Allura/)
  assert.ok(await page.locator("#finish").isDisabled(), "Finish still disabled until the box is ticked")
  await page.check("#agree")
  assert.ok(await page.locator("#finish").isEnabled())
  await page.click("#finish")
  await page.waitForURL(sellerLinks[0])
  assert.match(await page.locator("h1").innerText(), /Thank you, Margaret/)
  assert.match(await page.locator("main").innerText(), /Once everyone has signed/)
  assert.equal(links().length, 2, "buyer is not invited while a seller is still outstanding")
})

test("seller 2 signs the addendum card with a drawn signature", async () => {
  await consent(sellerLinks[1])
  assert.ok(await page.locator("#addcard").isVisible(), "addendum signer gets the 'Your signature' card")
  assert.equal(await page.locator(".pagewrap .spot").count(), 0, "…and no on-page tab")
  await page.click("#signtab")
  await page.fill("#typed_name", "Harold Thompson")
  await page.click('.tabbtn[data-tab="draw"]')
  await page.click("#adopt")
  assert.match(await page.locator("#sheeterr").innerText(), /Draw your signature/)
  const pad = await page.locator("#pad").boundingBox()
  const pts = [[0.1, 0.7], [0.2, 0.3], [0.35, 0.75], [0.5, 0.25], [0.65, 0.7], [0.8, 0.35], [0.9, 0.6]]
  await page.mouse.move(pad.x + pad.width * pts[0][0], pad.y + pad.height * pts[0][1])
  await page.mouse.down()
  for (const [fx, fy] of pts.slice(1)) await page.mouse.move(pad.x + pad.width * fx, pad.y + pad.height * fy, { steps: 6 })
  await page.mouse.up()
  await page.click("#cancelsheet")
  assert.ok(await page.locator("#sheet").isHidden(), "Cancel closes the sheet")
  await page.click("#signtab")
  assert.equal(await page.inputValue("#typed_name"), "Harold Thompson", "typed name survives cancel")
  await page.click("#adopt")
  await page.waitForTimeout(400)
  const img = page.locator("#sigpreview img")
  assert.equal(await img.count(), 1, "drawn signature previews as an image")
  assert.match(await img.getAttribute("src"), /^data:image\/png;base64,/)
  await page.check("#agree")
  await page.click("#finish")
  await page.waitForURL(sellerLinks[1])
  assert.match(await page.locator("h1").innerText(), /Thank you, Harold/)
  buyerLink = (await waitFor(() => { const l = links(); return l.length === 3 ? l : null }, "buyer invitation after both sellers signed"))[2]
})

test("buyer signs last and the envelope completes with a downloadable final.pdf", async () => {
  await consent(buyerLink)
  const tab = page.locator("#signtab")
  await tab.scrollIntoViewIfNeeded()
  const t = await tab.boundingBox(), p2 = await page.locator(".pagewrap").nth(1).boundingBox()
  const lineY = p2.y + p2.height * ((792 - 280) / 792) // TEMPLATE.buyer.lineY
  assert.ok(Math.abs(t.y + t.height - lineY) <= 2.5, "buyer tab sits on the buyer line")
  await tab.click()
  await page.fill("#typed_name", "Ryan LaRocca")
  await page.click("#adopt")
  await page.waitForTimeout(300)
  await page.check("#agree")
  await page.click("#finish")
  await page.waitForURL(buyerLink)
  const text = await page.locator("main").innerText()
  assert.match(text, /Thank you, Ryan/)
  assert.match(text, /Everyone has signed/)
  await waitFor(() => /Completed: Purchase Agreement/.test(stdout), "completion emails")
  const res = await page.request.get(`${buyerLink}/final.pdf`)
  assert.equal(res.status(), 200)
  assert.equal(res.headers()["content-type"], "application/pdf")
  assert.match(res.headers()["content-disposition"], /SIGNED\.pdf/)
  const bytes = await res.body()
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-")
  const finalPath = path.join(dataDir, "envelopes", envelopeId, "final.pdf")
  assert.ok(fs.existsSync(finalPath))
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), crypto.createHash("sha256").update(fs.readFileSync(finalPath)).digest("hex"))
  assert.equal(fs.statSync(finalPath).mode & 0o222, 0, "final.pdf is read-only")
  assert.equal(stdout.match(/subject="Completed: Purchase Agreement/g).length, 3, "one completion email per email signer + Ryan")
})

test("verify page shows status, signers and the fingerprint of the served file", async () => {
  await page.goto(`${base}/verify/${envelopeId}`)
  const text = await page.locator("main").innerText()
  assert.match(text, /completed/)
  for (const n of ["Margaret Ann Thompson", "Harold Thompson", "Ryan LaRocca"]) assert.match(text, new RegExp(`${n}[\\s\\S]*signed`))
  const sha = /Final \(with certificate\):\s*([0-9a-f]{64})/.exec(text)?.[1]
  assert.ok(sha, "final SHA-256 is shown")
  const res = await page.request.get(`${base}/verify/${envelopeId}/final.pdf`)
  assert.equal(res.status(), 200)
  assert.equal(crypto.createHash("sha256").update(await res.body()).digest("hex"), sha)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  // a signed link now shows the done page again; a bad token is a 404
  await page.goto(sellerLinks[0])
  assert.match(await page.locator("main").innerText(), /Download the signed PDF/)
  assert.equal((await fetch(`${base}/s/${"x".repeat(43)}`)).status, 404)
})

test("admin detail shows the completed envelope and the locked files", async () => {
  await page.goto(`${base}/admin/e/${envelopeId}`)
  const text = await page.locator("main").innerText()
  assert.match(text, /completed/)
  assert.match(text, /Signed PDF \+ certificate/)
  assert.match(text, /Final SHA-256/)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, "no horizontal scroll on the detail page")
  const res = await page.request.post(`${base}/admin/e/${envelopeId}/void`)
  assert.match(await res.text(), /Completed documents cannot be voided/)
})
