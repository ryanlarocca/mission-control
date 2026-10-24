// Inbox Agent — the HomeSentry / Tap Inspect flow
// (briefs/BRIEF_INBOX_VENDOR_FILING_TAPINSPECT_2026-10-16.md, Part B).
//
//   fetchTapInspect({ url, jobId, log, headed })
//     → { ok: true,  files: [{ filename, mime, bytes }], screenshots, steps }
//     → { ok: false, error, needs: "payment" | null, screenshots, steps }
//
// The share page (https://app.tapinspect.com/shares/<uuid>, public, no login —
// probed headless 2026-10-16) shows the company header, a block of static
// instructions ("If you have not signed pre-inspection or made payment results
// will not be viewable … scroll to the bottom at left side of report and you
// will see a download report button … or tap the 3 dots at upper right"), then
// `Reports` → "Home Inspection Report" and `Attachments` → Invoice, the signed
// agreement, the maintenance manual. The instruction text is present even when
// the report IS viewable, so it is never the gate signal. Gate = after clicking
// the report entry, no download control appears (the view fails to render or
// shows a payment / agreement message) → `needs: "payment"`; the worker parks
// the job as awaiting_payment and retries daily. The agent never pays, never
// opens the invoice or agreement, never downloads the manual.
//
// Every selector / text match lives in SELECTORS so a drift fix is one line.
import { captureDownload, labelsOf, makeShooter, mimeFor, openBrowser } from "./browser.mjs"

export const TAPINSPECT_JOB_TIMEOUT_MS = 120_000

export const SELECTORS = {
  /** The entry under `Reports` that opens the report view. */
  reportEntry: /^home inspection report$/i,
  reportEntryLoose: /inspection report/i,
  /** Anything in `Attachments` (and the payment button) the flow must never click. */
  forbidden: /invoice|agreement|maintenance manual|manual|pay|payment|sign|login|log in|sign in/i,
  /** The report view's download control: bottom-left button, or the ⋮ menu → Download. */
  downloadButton: /^download(\s+(report|pdf))?$/i,
  downloadButtonLoose: /download\s*(report|pdf)/i,
  moreMenu: /^(more|more options|options|menu|more_vert)$/i,
  moreMenuItem: /^download(\s+(report|pdf))?$/i,
  /** Live 2026-10-16 (Halleck): "Download Report" is a dropdown — "Download Full Report" /
   *  "Download Report Summary Only". Always the full report. */
  downloadMenuItem: /^download full report$/i,
  /** On the report view (not the share page): the "not viewable yet" messages. */
  gate: /not (?:yet )?(?:viewable|available|released)|results? (?:are|is|will) not (?:be )?viewable|(?:make|made|pending|awaiting|require[sd]?|outstanding|unpaid) (?:a )?payment|payment (?:is )?(?:required|pending|due|outstanding)|balance due|invoice (?:is )?(?:unpaid|outstanding|due)|(?:sign|signed) (?:the )?(?:pre-?inspection )?agreement|agreement (?:is )?(?:required|pending|unsigned)/i,
  /** The share page's static instructions — recognised only so they are never read as a gate. */
  instructions: /please click on view report|if you have not signed pre-inspection or made payment/i,
  /** Where the report view's text begins (used to drop the instructions block before the gate check). */
  reportsHeading: /^reports$/im,
}

/** Labels the tapinspect flow may click; anything matching SELECTORS.forbidden is refused first. */
export const TAP_CLICK_ALLOW = [SELECTORS.reportEntry, SELECTORS.reportEntryLoose, SELECTORS.downloadButton, SELECTORS.downloadButtonLoose, SELECTORS.moreMenu, SELECTORS.moreMenuItem, SELECTORS.downloadMenuItem, /^(close|ok|got it)$/i]

function cleanLabel(label) {
  return String(label || "").replace(/[……]+$/g, "").replace(/[^\p{L}\p{N}&\s_]/gu, " ").replace(/\s+/g, " ").trim()
}
/** {ok} when any candidate label is allowed and none is forbidden (each label judged on its own). */
export function tapClickAllowed(labels) {
  const list = (Array.isArray(labels) ? labels : [labels]).map(cleanLabel).filter(Boolean)
  if (!list.length) return { ok: false, why: "empty label" }
  for (const l of list) if (SELECTORS.forbidden.test(l)) return { ok: false, why: `refused: "${l}" is an attachment / payment control` }
  for (const l of list) if (TAP_CLICK_ALLOW.some((re) => re.test(l))) return { ok: true }
  return { ok: false, why: `not on the tapinspect allowlist: ${list.map((l) => `"${l}"`).join(" / ")}` }
}

/**
 * Gate from the REPORT VIEW's text (never the share page's): "payment" when a
 * payment / agreement message is showing, else null. The share page's static
 * instructions are stripped first so they can never trip it.
 */
export function gateFromReportText(text) {
  let t = String(text || "")
  t = t.replace(SELECTORS.instructions, "").replace(/If you have not signed pre-inspection or made payment results will not be viewable\.?/gi, "")
  return SELECTORS.gate.test(t) ? "payment" : null
}

const NEEDS_WHY = { payment: "report not viewable yet (payment/agreement pending)" }

async function settle(page, ms = 1_200) {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {})
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
  await page.waitForTimeout(ms)
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
async function safeTapClick(locator, { expect = "", log = () => {}, timeout = 8_000, noWaitAfter = false } = {}) {
  const labels = await labelsOf(locator)
  const check = tapClickAllowed(labels.length ? labels : [expect])
  if (!check.ok) {
    log(`[fetch] tapinspect: click refused (${check.why})${expect ? ` — wanted "${expect}"` : ""}`)
    return false
  }
  await locator.click({ timeout, noWaitAfter })
  return true
}

/** The "Home Inspection Report" entry under Reports (link, button, or a clickable row). */
async function reportEntry(page) {
  return firstVisible(page, [
    (p) => p.getByRole("link", { name: SELECTORS.reportEntry }),
    (p) => p.getByRole("button", { name: SELECTORS.reportEntry }),
    (p) => p.getByText(SELECTORS.reportEntry),
    (p) => p.getByRole("link", { name: SELECTORS.reportEntryLoose }),
    (p) => p.getByText(SELECTORS.reportEntryLoose),
  ], 4_000)
}
/** The bottom-left download control on the report view. */
async function downloadControl(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {})
  await page.waitForTimeout(500)
  return firstVisible(page, [
    (p) => p.getByRole("button", { name: SELECTORS.downloadButton }),
    (p) => p.getByRole("link", { name: SELECTORS.downloadButton }),
    (p) => p.getByRole("button", { name: SELECTORS.downloadButtonLoose }),
    (p) => p.getByRole("link", { name: SELECTORS.downloadButtonLoose }),
    (p) => p.locator('a[href$=".pdf" i], a[href*="/pdf" i], a[download]'),
    (p) => p.locator('button[aria-label*="download" i], a[aria-label*="download" i], [data-testid*="download" i]'),
    (p) => p.getByText(SELECTORS.downloadButtonLoose),
  ], 3_000)
}
/** Fallback: the ⋮ menu top-right → Download. */
async function downloadViaMenu(page, log) {
  const more = await firstVisible(page, [
    (p) => p.getByRole("button", { name: SELECTORS.moreMenu }),
    (p) => p.locator('button[aria-label*="more" i], button[aria-label*="menu" i], button[aria-label*="options" i], [data-testid*="more" i]'),
    (p) => p.getByText(/^more_vert$/),
  ], 2_000)
  if (!more || !(await safeTapClick(more, { expect: "More", log }))) return null
  await page.waitForTimeout(500)
  return firstVisible(page, [
    (p) => p.getByRole("menuitem", { name: SELECTORS.moreMenuItem }),
    (p) => p.getByRole("button", { name: SELECTORS.moreMenuItem }),
    (p) => p.getByText(SELECTORS.moreMenuItem),
  ], 2_000)
}

/** The report view opened in a new tab? Prefer it; otherwise the same page. */
async function pageAfterClick(context, page, trigger) {
  const popup = context.waitForEvent("page", { timeout: 6_000 }).catch(() => null)
  await trigger()
  const opened = await popup
  if (opened) {
    await opened.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {})
    return opened
  }
  return page
}

/** A control whose href is the PDF itself (no download event): fetch the bytes in-session. */
async function fetchHrefPdf(page, control) {
  const href = await control.getAttribute("href").catch(() => null)
  if (!href || !/\.pdf(\?|$)|\/pdf\b/i.test(href)) return null
  // The Invoice / Agreement / Maintenance Manual attachments are hrefs too: judge the
  // control's label and the href itself the way a click would be judged.
  const labels = await labelsOf(control)
  if (!tapClickAllowed(labels.length ? labels : ["Download report"]).ok) return null
  if (SELECTORS.forbidden.test(decodeURIComponent(href))) return null
  const abs = new URL(href, page.url()).href
  const res = await page.request.get(abs, { timeout: 30_000 }).catch(() => null)
  if (!res || !res.ok()) return null
  const bytes = Buffer.from(await res.body())
  if (!bytes.length || mimeFor("x", bytes) !== "application/pdf") return null
  const filename = decodeURIComponent(abs.split("/").pop().split("?")[0] || "report.pdf") || "report.pdf"
  return { filename: /\.pdf$/i.test(filename) ? filename : `${filename}.pdf`, mime: "application/pdf", bytes }
}

/**
 * @returns {Promise<{ok:true, files:Array<{filename,mime,bytes}>, screenshots:string[], steps:string[]} |
 *                   {ok:false, error:string, needs:"payment"|null, screenshots:string[], steps:string[]}>}
 */
export async function fetchTapInspect({ url, jobId = "job", log = () => {}, headed = false }) {
  const { context, page, close } = await openBrowser({ headed })
  const shooter = makeShooter(page, jobId)
  const steps = []
  const fail = (needs, error) => ({ ok: false, error, needs, screenshots: shooter.shots, steps })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await settle(page)
    await shooter.shot("share")
    const entry = await reportEntry(page)
    if (!entry) {
      await shooter.shot("no-report-entry")
      const text = await bodyText(page)
      if (/not found|no longer available|expired|invalid/i.test(text)) return fail(null, "the share page is gone (not found / expired)")
      // Live 2026-10-24 (Quito): before the invoice is paid the share page has no
      // `Reports` section at all — just "Payment is required before you can access
      // your inspection results" over the agreement + invoice. A live share page
      // with no report entry is "not released yet", never a failure: park it.
      steps.push(gateFromReportText(text) ? "share-gated" : "share-no-report")
      log(`[fetch] tapinspect: ${steps.join(" → ")} — no report on the share page yet`)
      return fail("payment", NEEDS_WHY.payment)
    }
    steps.push("share")
    let view = page
    const clicked = await (async () => {
      let ok = false
      view = await pageAfterClick(context, page, async () => {
        ok = await safeTapClick(entry, { expect: "Home Inspection Report", log, noWaitAfter: true })
      })
      return ok
    })()
    if (!clicked) return fail(null, "Home Inspection Report entry not clickable")
    await settle(view, 2_000)
    const viewShooter = view === page ? shooter : makeShooter(view, `${jobId}-view`)
    await viewShooter.shot("report")
    steps.push("report")
    // Still looking at the share page (the click did not open the report)? Its
    // Attachments section has Download links of its own — never search it for a
    // download control. Treat as not viewable yet.
    if (SELECTORS.instructions.test(await bodyText(view))) {
      await viewShooter.shot("still-share")
      steps.push("still-share")
      log(`[fetch] tapinspect: ${steps.join(" → ")} — the report did not open (still the share page)`)
      return fail("payment", NEEDS_WHY.payment)
    }

    // The gate: no download control on the report view → not viewable yet.
    let control = await downloadControl(view)
    let how = "button"
    if (!control) {
      control = await downloadViaMenu(view, log)
      how = "menu"
    }
    if (!control) {
      const text = await bodyText(view)
      const gate = gateFromReportText(text)
      await viewShooter.shot(gate ? "gated" : "no-download-control")
      steps.push(gate ? "gated" : "no-download")
      log(`[fetch] tapinspect: ${steps.join(" → ")} — ${gate ? "payment/agreement message on the report view" : "no download control within the timeout"}`)
      return fail("payment", NEEDS_WHY.payment)
    }
    steps.push(`download(${how})`)
    let file = await fetchHrefPdf(view, control)
    if (!file) {
      // The control may be a dropdown toggle ("Download Report ▾" → "Download Full
      // Report" / "… Summary Only"); when the submenu shows, pick the full report.
      file = await captureDownload(view, async () => {
        if (!(await safeTapClick(control, { expect: "Download report", log, noWaitAfter: true }))) return false
        await view.waitForTimeout(400)
        const item = await firstVisible(view, [
          (p) => p.getByRole("menuitem", { name: SELECTORS.downloadMenuItem }),
          (p) => p.getByRole("link", { name: SELECTORS.downloadMenuItem }),
          (p) => p.getByRole("button", { name: SELECTORS.downloadMenuItem }),
          (p) => p.getByText(SELECTORS.downloadMenuItem),
        ], 2_000)
        if (!item) return true
        steps.push("full-report")
        return safeTapClick(item, { expect: "Download Full Report", log, noWaitAfter: true })
      }, { timeout: 45_000 })
    }
    if (!file) {
      await viewShooter.shot("no-download")
      return fail(null, "the download control produced no file")
    }
    if (file.mime !== "application/pdf") {
      await viewShooter.shot("not-a-pdf")
      return fail(null, `downloaded ${file.filename} is ${file.mime}, not a PDF`)
    }
    await viewShooter.shot("downloaded")
    log(`[fetch] tapinspect: ${steps.join(" → ")} → ${file.filename} (${file.bytes.length} bytes)`)
    return { ok: true, files: [file], screenshots: [...shooter.shots, ...(viewShooter === shooter ? [] : viewShooter.shots)], steps }
  } catch (e) {
    await shooter.shot("error")
    return fail(null, e?.message || String(e))
  } finally {
    await close()
  }
}
