// Inbox Agent — the FreshBooks client-link flow
// (briefs/BRIEF_INBOX_STAGING_VENDOR_FRESHBOOKS_2026-10-17.md, Part C).
//
//   fetchFreshBooks({ url, jobId, log, headed })
//     → { ok: true,  files: [{ filename, mime, bytes, kind, pageText }], screenshots, steps }
//     → { ok: false, error, needs: "login" | "expired" | null, screenshots, steps }
//
// StyleMe Home Staging (Kowi Chandra) bills through FreshBooks. The email has
// no attachment — only https://my.freshbooks.com/#/link/… — and the operator
// probed both links headless (2026-10-17, no login, no profile): a hash-routed
// SPA renders the proposal / invoice with buttons Print, Download PDF, View
// Comments, Send, View History, "Create an account…", "Save this Proposal"; the
// text carries the property ("Prepared For Ryan LaRocca 2116 Quito Rd, San
// Jose, CA 95130" / "Billed To …") and the amount ("Amount Due (USD) $3,253.75",
// "Outstanding $3,253.75 is due on Oct 17, 2026"). `networkidle` may never
// settle on that page, so the flow waits for the document itself (the heading
// or the Download PDF button) for up to ~20 s.
//
// The agent clicks Download PDF and nothing else: never Pay, Accept, Save this
// Proposal, Create an account, Send, View Comments, never a sign/agree/submit
// control, and it never types into anything. No Download PDF within the wait →
// a login wall or an expired link (the jwt carries an `exp` about a year out)
// → { ok: false, needs } with the screenshot; the worker applies its normal
// retry policy (no awaiting_payment parking here).
//
// Every selector / text match lives in SELECTORS so a drift fix is one line.
import { captureDownload, labelsOf, makeShooter, openBrowser } from "./browser.mjs"
import { addressIn, freshbooksKind, freshbooksNumber } from "./providers.mjs"

export const FRESHBOOKS_JOB_TIMEOUT_MS = 120_000
/** How long the SPA gets to render the document (heading or Download PDF button). */
export const FRESHBOOKS_RENDER_WAIT_MS = 20_000

export const SELECTORS = {
  /** The one control the flow clicks. */
  downloadPdf: /^download pdf$/i,
  downloadPdfLoose: /download\s*pdf/i,
  /** Document rendered: "Proposal SS01174" / "Invoice 080223VA" / "Estimate …" somewhere in the page text. */
  heading: /\b(proposal|invoice|estimate)\s*(?:#|no\.?|number)?\s*[A-Z0-9][A-Z0-9-]{3,}/i,
  /** Everything the flow must never click (judged before the allowlist). */
  forbidden: /\bpay\b|payment|accept|save this (proposal|estimate|invoice)|create an account|\bsend\b|view comments?|view history|\bprint\b|\bsign\b|agree|submit|decline|log ?in|sign ?in|sign ?up|password/i,
  /** The page asked for credentials. */
  login: /log ?in to (?:your )?(?:freshbooks|account)|sign ?in to|enter your password|password\b.*\b(?:log|sign) ?in|create an account to (?:view|see)|you need to (?:log|sign) ?in/i,
  /** The link is dead. */
  expired: /link (?:has )?expired|expired link|no longer (?:available|valid)|not found|invalid (?:link|token)|page (?:doesn't|does not) exist|something went wrong/i,
  /** Where the property lives on the page: "Prepared For Ryan LaRocca 2116 Quito Rd, …" / "Billed To …". */
  addressLead: /(?:prepared for|billed to|bill to|client)\s*:?\s*/i,
  /** Amount labels, in the order they are trusted (an unpaid invoice's Amount Due is the total; a paid one reads $0.00). */
  amount: [/\bfor\s+\$\s*([\d,]+(?:\.\d{2})?)/i, /amount due(?:\s*\(USD\))?\s*:?\s*\$\s*([\d,]+(?:\.\d{2})?)/i, /\bgrand total(?:\s*\(USD\))?\s*:?\s*\$\s*([\d,]+(?:\.\d{2})?)/i, /(?:^|[^a-z])total(?:\s*\(USD\))?\s*:?\s*\$\s*([\d,]+(?:\.\d{2})?)/i, /outstanding\s*:?\s*\$\s*([\d,]+(?:\.\d{2})?)/i],
}

/** Labels the FreshBooks flow may click; anything matching SELECTORS.forbidden is refused first. */
export const FB_CLICK_ALLOW = [SELECTORS.downloadPdf, SELECTORS.downloadPdfLoose, /^(close|ok|got it|dismiss)$/i]

function cleanLabel(label) {
  return String(label || "").replace(/[……]+$/g, "").replace(/[^\p{L}\p{N}&\s_]/gu, " ").replace(/\s+/g, " ").trim()
}
/** {ok} when any candidate label is allowed and none is forbidden (each label judged on its own). */
export function fbClickAllowed(labels) {
  const list = (Array.isArray(labels) ? labels : [labels]).map(cleanLabel).filter(Boolean)
  if (!list.length) return { ok: false, why: "empty label" }
  for (const l of list) if (SELECTORS.forbidden.test(l)) return { ok: false, why: `refused: "${l}" is a pay / accept / send / account control` }
  for (const l of list) if (FB_CLICK_ALLOW.some((re) => re.test(l))) return { ok: true }
  return { ok: false, why: `not on the FreshBooks allowlist: ${list.map((l) => `"${l}"`).join(" / ")}` }
}

/**
 * Why there is no Download PDF: "login" (a credentials wall), "expired" (dead
 * link), or null (the page simply never rendered — a retry may do it).
 */
export function freshbooksGate(text) {
  const t = String(text || "")
  if (SELECTORS.login.test(t)) return "login"
  if (SELECTORS.expired.test(t)) return "expired"
  return null
}

/** The property named on the page: the "Prepared For" / "Billed To" block first (the vendor's own San Jose address can appear higher up), then anywhere. */
export function freshbooksAddress(text) {
  const t = String(text || "")
  const re = new RegExp(SELECTORS.addressLead.source + "([^\\n]*(?:\\n[^\\n]*){0,3})", "gi")
  for (const m of t.matchAll(re)) {
    const a = addressIn(m[1])
    if (a) return a
  }
  return addressIn(t)
}

/** The amount on an invoice / proposal: the first label hit that is not $0.00, else the first hit, else null. */
export function freshbooksAmount(...texts) {
  let first = null
  for (const text of texts) {
    const t = String(text || "")
    for (const re of SELECTORS.amount) {
      const m = re.exec(t)
      if (!m) continue
      const n = Number(m[1].replace(/,/g, ""))
      if (!Number.isFinite(n)) continue
      if (first === null) first = n
      if (n > 0) return n
    }
  }
  return first
}

/**
 * What the rendered page says about the document — pure, for the filing path
 * and the tests: { kind, number, address, amount, status }.
 * @param {string|null|undefined} text page.innerText
 * @param {string|null|undefined} [url] the link (kind + number fall back to its params)
 */
export function parseFreshbooksPage(text, url = null) {
  const t = String(text || "")
  const h = SELECTORS.heading.exec(t)
  const kind = freshbooksKind(url) || (h ? (/^invoice$/i.test(h[1]) ? "invoice" : "proposal") : null)
  const number = freshbooksNumber(url) || (h ? h[0].replace(/^\s*(proposal|invoice|estimate)\s*(?:#|no\.?|number)?\s*/i, "").trim() : null)
  const status = /\bpaid\b/i.test(t) && !/unpaid|outstanding\s*\$\s*[1-9]/i.test(t) ? "paid" : /outstanding|amount due/i.test(t) ? "outstanding" : /\binvoiced\b/i.test(t) ? "invoiced" : null
  return { kind, number, address: freshbooksAddress(t), amount: freshbooksAmount(t), status }
}

async function bodyText(page) {
  return page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")
}
async function firstVisible(page, candidates, timeout = 1_500) {
  for (const make of candidates) {
    try {
      const loc = make(page).first()
      await loc.waitFor({ state: "visible", timeout })
      return loc
    } catch {}
  }
  return null
}
async function safeFbClick(locator, { expect = "", log = () => {}, timeout = 8_000, noWaitAfter = false } = {}) {
  const labels = await labelsOf(locator)
  const check = fbClickAllowed(labels.length ? labels : [expect])
  if (!check.ok) {
    log(`[fetch] freshbooks: click refused (${check.why})${expect ? ` — wanted "${expect}"` : ""}`)
    return false
  }
  await locator.click({ timeout, noWaitAfter })
  return true
}
/** The Download PDF control (button, link, or a labelled element). */
async function downloadControl(page, timeout = 1_500) {
  return firstVisible(page, [
    (p) => p.getByRole("button", { name: SELECTORS.downloadPdf }),
    (p) => p.getByRole("link", { name: SELECTORS.downloadPdf }),
    (p) => p.getByRole("button", { name: SELECTORS.downloadPdfLoose }),
    (p) => p.getByRole("link", { name: SELECTORS.downloadPdfLoose }),
    (p) => p.locator('button[aria-label*="download pdf" i], a[aria-label*="download pdf" i], [data-testid*="download-pdf" i], [data-test*="download-pdf" i]'),
    (p) => p.getByText(SELECTORS.downloadPdf),
  ], timeout)
}
/** Wait for the SPA to show the document: the Download PDF control or the heading, polled up to the render budget. */
async function waitForDocument(page, budgetMs) {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    const control = await downloadControl(page, 1_000)
    if (control) return { control, rendered: true }
    if (SELECTORS.heading.test(await bodyText(page))) return { control: null, rendered: true }
    const text = await bodyText(page)
    if (freshbooksGate(text)) return { control: null, rendered: false }
    await page.waitForTimeout(500)
  }
  return { control: null, rendered: false }
}

/**
 * @returns {Promise<{ok:true, files:Array<{filename:string, mime:string, bytes:Buffer, kind:"staging_proposal"|"staging_invoice"|null, pageText:string}>, screenshots:string[], steps:string[]} |
 *                   {ok:false, error:string, needs:"login"|"expired"|null, screenshots:string[], steps:string[]}>}
 */
export async function fetchFreshBooks({ url, jobId = "job", log = () => {}, headed = false }) {
  const { page, close } = await openBrowser({ headed })
  const shooter = makeShooter(page, jobId)
  const steps = []
  const fail = (needs, error) => ({ ok: false, error, needs, screenshots: shooter.shots, steps })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForTimeout(1_000)
    await shooter.shot("link")
    steps.push("link")
    let { control, rendered } = await waitForDocument(page, FRESHBOOKS_RENDER_WAIT_MS)
    let text = await bodyText(page)
    if (rendered && !control) {
      // The heading showed before the toolbar did — give the buttons a moment more.
      await page.waitForTimeout(1_500)
      control = await downloadControl(page, 3_000)
      text = await bodyText(page)
    }
    if (!control) {
      const gate = freshbooksGate(text)
      await shooter.shot(gate || (rendered ? "no-download-pdf" : "not-rendered"))
      steps.push(gate || "no-download")
      log(`[fetch] freshbooks: ${steps.join(" → ")} — ${gate === "login" ? "the page wants a login" : gate === "expired" ? "the link is dead" : rendered ? "the document rendered without a Download PDF button" : "the document never rendered"}`)
      return fail(gate, gate === "login" ? "FreshBooks wants a login to show this document" : gate === "expired" ? "the FreshBooks link has expired or is invalid" : rendered ? "no Download PDF button on the FreshBooks page" : `the FreshBooks page did not render in ${Math.round(FRESHBOOKS_RENDER_WAIT_MS / 1000)}s`)
    }
    await shooter.shot("document")
    steps.push("document")
    const file = await captureDownload(page, async () => safeFbClick(control, { expect: "Download PDF", log, noWaitAfter: true }), { timeout: 45_000 })
    if (!file) {
      await shooter.shot("no-download")
      return fail(null, "Download PDF produced no file")
    }
    if (file.mime !== "application/pdf") {
      await shooter.shot("not-a-pdf")
      return fail(null, `downloaded ${file.filename} is ${file.mime}, not a PDF`)
    }
    steps.push("download")
    await shooter.shot("downloaded")
    const kind = freshbooksKind(url) || parseFreshbooksPage(text, url).kind
    const docKind = kind === "proposal" ? "staging_proposal" : kind === "invoice" ? "staging_invoice" : null
    log(`[fetch] freshbooks: ${steps.join(" → ")} → ${file.filename} (${file.bytes.length} bytes)${docKind ? ` · ${docKind}` : ""}`)
    return { ok: true, files: [{ ...file, kind: docKind, pageText: text }], screenshots: shooter.shots, steps }
  } catch (e) {
    await shooter.shot("error")
    return fail(null, e?.message || String(e))
  } finally {
    await close()
  }
}
