// Inbox Agent — the DocuSign flow (briefs/BRIEF_INBOX_LINK_FETCH_2026-10-12.md §1).
//
// Two entry shapes, same flow:
//   1. …/Signing/EmailStart.aspx?a=…&etti=…&r=…  (request *and* completed emails)
//      → redirects into …/Signing/?ti=… (sometimes a "Review Documents" button first)
//   2. app.docusign.com/documents/details/<id> (needs the persistent-profile login)
//
// Gates, in order: e-records consent (tick + CONTINUE) → access code (type it,
// or `needs: "access_code"`) → ID verification / phone auth / "sign in to view"
// (`needs: "login"`) → expired / voided / no longer accessible (`needs: "expired"`).
// Phase 1b (2026-10-12, after the first live run): DocuSign *email* links expire
// (the 10/06 Ridgeview link was dead six days later). The expired page offers
// SEND NEW LINK — "Docusign will send a fresh link to your email address" —
// and that address is ryan@, the mailbox the agent reads. So the flow clicks
// it (it sends an email, nothing else) and returns `needs: "new_link"`; the
// worker parks the job until the fresh link arrives and is fetched like any
// other. No button → `needs: "expired"` as before.
// Then download — Separate PDFs preferred (a ZIP, one PDF per document, keeps
// DocuSign's document names, which match what the agent files disclosures
// under), Combined PDF as the fallback — then Finish Later / close. Never
// anything else: every click is vetted by browser.mjs isAllowedClick().
//
// Selectors drift: role/text first, data-qa second, a short list of fallbacks
// per step, a screenshot before giving up.
import { captureDownload, isAllowedClick, labelOf, makeShooter, openBrowser, safeClick } from "./browser.mjs"

// Page-text signatures of each gate. Exported for the unit test.
export const CONSENT_RE = /agree to use electronic records and signatures|electronic record and signature disclosure/i
export const ACCESS_CODE_RE = /access code/i
export const LOGIN_RE = /log ?in to (view|continue|access)|sign in to (view|continue|access)|verify your identity|identity verification|id verification|phone authentication|we('ll| will) (text|call) you|enter the code we sent|send (me )?a code|knowledge[- ]based|please log in/i
export const EXPIRED_RE = /has expired|envelope (has been|was) voided|voided by|no longer be accessed|can no longer access|has been deleted|is no longer available|not available for signing|this link is no longer valid|invalid (link|request)|cannot be accessed|has been completed and can no longer/i

/** Classify a page by its visible text alone (no DOM needed). */
export function gateFromText(text) {
  const t = String(text || "")
  if (EXPIRED_RE.test(t)) return "expired"
  if (CONSENT_RE.test(t)) return "consent"
  if (ACCESS_CODE_RE.test(t)) return "access_code"
  if (LOGIN_RE.test(t)) return "login"
  return null
}

const NEEDS_WHY = {
  access_code: "the envelope wants an access code",
  login: "DocuSign wants a login or ID verification",
  expired: "the envelope is expired, voided or no longer accessible",
  new_link: "asked DocuSign for a fresh link",
}

async function settle(page, ms = 1_200) {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {})
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
  await page.waitForTimeout(ms)
}
async function bodyText(page) {
  return page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")
}
/** First visible locator among the candidates (each a function returning a Locator), else null. */
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

// ---------------------------------------------------------------- gates
async function consentGate(page) {
  const box = await firstVisible(page, [
    (p) => p.getByRole("checkbox", { name: /electronic records/i }),
    (p) => p.locator("#disclosureAccepted"),
    (p) => p.locator('input[type="checkbox"][name*="disclosure" i], input[type="checkbox"][data-qa*="disclosure" i], input[type="checkbox"][data-qa*="consent" i]'),
    (p) => p.locator('input[type="checkbox"]'),
  ])
  return box
}
async function accessCodeInput(page) {
  return firstVisible(page, [
    (p) => p.getByLabel(/access code/i),
    (p) => p.locator('input[name*="accesscode" i], input[id*="accesscode" i], input[data-qa*="access-code" i], input[data-qa*="accesscode" i]'),
    (p) => p.getByPlaceholder(/access code|enter code/i),
  ])
}
async function continueButton(page) {
  return firstVisible(page, [
    (p) => p.getByRole("button", { name: /^continue$/i }),
    (p) => p.locator('[data-qa="continue"], [data-qa*="continue" i], button#action-bar-btn-continue'),
    (p) => p.getByText(/^continue$/i),
  ])
}
/** The expired-link page's SEND NEW LINK button (Phase 1b). LOG IN sits next to it and is never clicked here. */
async function sendNewLinkButton(page) {
  return firstVisible(page, [
    (p) => p.getByRole("button", { name: /^send new link$/i }),
    (p) => p.getByRole("link", { name: /^send new link$/i }),
    (p) => p.locator('[data-qa*="send-new-link" i], [data-qa*="sendnewlink" i]'),
    (p) => p.getByText(/^send new link$/i),
  ], 2_000)
}
async function reviewButton(page) {
  return firstVisible(page, [
    (p) => p.getByRole("button", { name: /^review documents?$/i }),
    (p) => p.getByRole("link", { name: /^review documents?$/i }),
    (p) => p.locator('[data-qa*="review-doc" i]'),
  ], 800)
}

/** Which gate is the page showing right now? {kind, ...handles} or null when the documents are open. */
export async function detectGate(page) {
  const text = await bodyText(page)
  const review = await reviewButton(page)
  if (review) return { kind: "review", button: review }
  if (CONSENT_RE.test(text)) {
    const box = await consentGate(page)
    if (box) return { kind: "consent", box }
  }
  if (ACCESS_CODE_RE.test(text)) {
    const input = await accessCodeInput(page)
    if (input) return { kind: "access_code", input }
  }
  const byText = gateFromText(text)
  if (byText === "login" || byText === "expired") return { kind: byText }
  const loginForm = await firstVisible(page, [(p) => p.locator('input[type="password"], input[name="email"][type="email"]')], 500)
  if (loginForm && !(await accessCodeInput(page))) return { kind: "login" }
  return null
}

// ---------------------------------------------------------------- download
async function clickDownloadEntry(page, log) {
  // Completed envelopes: a download icon in the toolbar.
  const icon = await firstVisible(page, [
    (p) => p.getByRole("button", { name: /^download$/i }),
    (p) => p.locator('[data-qa="download"], [data-qa="download-button"], button[aria-label*="download" i], a[aria-label*="download" i]'),
  ], 2_000)
  if (icon && (await safeClick(icon, { expect: "Download", log }))) return "toolbar"
  // In-progress envelopes: OTHER ACTIONS → Print & Download.
  const other = await firstVisible(page, [
    (p) => p.getByRole("button", { name: /other actions/i }),
    (p) => p.locator('[data-qa="more-options"], [data-qa*="other-actions" i], button[aria-label*="other actions" i]'),
  ], 2_000)
  if (!other || !(await safeClick(other, { expect: "Other Actions", log }))) return null
  await page.waitForTimeout(600)
  const item = await firstVisible(page, [
    (p) => p.getByRole("menuitem", { name: /print\s*(&|and)\s*download/i }),
    (p) => p.locator('[data-qa="print-and-download"], [data-qa*="print" i][data-qa*="download" i]'),
    (p) => p.getByText(/^print\s*(&|and)\s*download$/i),
    (p) => p.getByRole("menuitem", { name: /^download$/i }),
  ], 2_000)
  if (!item || !(await safeClick(item, { expect: "Print & Download", log }))) return null
  return "other-actions"
}

/** The Print & Download dialog: pick Separate (fallback Combined), click Download, capture. */
async function downloadFromDialog(page, log) {
  await page.waitForTimeout(800)
  const dialog = (await firstVisible(page, [(p) => p.getByRole("dialog"), (p) => p.locator('[role="dialog"], [data-qa*="download-dialog" i], .download-dialog')], 3_000)) || page
  let mode = null
  for (const [name, finders] of [
    ["separate", [(d) => d.getByRole("radio", { name: /separate/i }), (d) => d.getByLabel(/separate/i), (d) => d.locator('[data-qa*="separate" i]'), (d) => d.getByText(/separate pdfs?/i)]],
    ["combined", [(d) => d.getByRole("radio", { name: /combined/i }), (d) => d.getByLabel(/combined/i), (d) => d.locator('[data-qa*="combined" i]'), (d) => d.getByText(/combined pdf/i)]],
  ]) {
    const opt = await firstVisible(dialog, finders, 1_200)
    if (!opt) continue
    const label = await labelOf(opt)
    const check = isAllowedClick(label || name)
    if (!check.ok) {
      log(`[fetch] docusign: option refused (${check.why})`)
      continue
    }
    const role = await opt.getAttribute("type").catch(() => null)
    if (role === "radio" || role === "checkbox") await opt.check({ timeout: 3_000 }).catch(() => opt.click({ timeout: 3_000 }))
    else await opt.click({ timeout: 3_000 })
    mode = name
    break
  }
  const go = await firstVisible(dialog, [
    (d) => d.getByRole("button", { name: /^download$/i }),
    (d) => d.locator('[data-qa*="download-button" i], [data-qa*="dialog-download" i], button[type="submit"]'),
    (d) => d.getByText(/^download$/i),
  ], 2_000)
  if (!go) return { mode, file: null }
  const file = await captureDownload(page, () => safeClick(go, { expect: "Download", log }), { timeout: 30_000 })
  return { mode, file }
}

async function finishLater(page, log) {
  const direct = await firstVisible(page, [
    (p) => p.getByRole("button", { name: /^finish later$/i }),
    (p) => p.getByRole("menuitem", { name: /^finish later$/i }),
    (p) => p.locator('[data-qa="finish-later"]'),
  ], 1_000)
  if (direct && (await safeClick(direct, { expect: "Finish Later", log }).catch(() => false))) return "finish-later"
  const other = await firstVisible(page, [(p) => p.getByRole("button", { name: /other actions/i }), (p) => p.locator('[data-qa="more-options"]')], 1_000)
  if (other && (await safeClick(other, { expect: "Other Actions", log }).catch(() => false))) {
    await page.waitForTimeout(500)
    const item = await firstVisible(page, [(p) => p.getByRole("menuitem", { name: /^finish later$/i }), (p) => p.getByText(/^finish later$/i)], 1_500)
    if (item && (await safeClick(item, { expect: "Finish Later", log }).catch(() => false))) return "finish-later"
    await page.keyboard.press("Escape").catch(() => {})
  }
  const close = await firstVisible(page, [(p) => p.getByRole("button", { name: /^close$/i }), (p) => p.locator('[data-qa="close"], button[aria-label="Close"]')], 800)
  if (close && (await safeClick(close, { expect: "Close", log }).catch(() => false))) return "close"
  return null
}

// ---------------------------------------------------------------- the flow
/**
 * `sendNewLink: false` keeps the expired gate from clicking SEND NEW LINK (the
 * worker passes it when another job already asked for this envelope's fresh link).
 * @returns {Promise<{ok:true, files:Array<{filename,mime,bytes}>, screenshots:string[], steps:string[]} |
 *                   {ok:false, error:string, needs:"access_code"|"login"|"expired"|"new_link"|null, screenshots:string[], steps:string[]}>}
 */
export async function fetchDocuSign({ url, accessCode = null, jobId = "job", log = () => {}, headed = false, sendNewLink = true }) {
  const { page, close } = await openBrowser({ headed })
  const shooter = makeShooter(page, jobId)
  const steps = []
  const fail = (needs, error) => ({ ok: false, error, needs, screenshots: shooter.shots, steps })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await settle(page)
    await shooter.shot("landing")
    let codeTried = false
    for (let i = 0; i < 6; i++) {
      const gate = await detectGate(page)
      if (!gate) break
      if (gate.kind === "expired") {
        steps.push("expired")
        await shooter.shot("expired")
        const btn = sendNewLink ? await sendNewLinkButton(page) : null
        if (btn && (await safeClick(btn, { expect: "Send New Link", log }))) {
          await settle(page, 2_500)
          steps.push("send_new_link")
          await shooter.shot("send_new_link")
          log(`[fetch] docusign: ${steps.join(" → ")} — fresh link requested, waiting for DocuSign's email`)
          return fail("new_link", NEEDS_WHY.new_link)
        }
        if (!sendNewLink) log("[fetch] docusign: expired — Send New Link skipped (already asked for this envelope)")
        return fail("expired", NEEDS_WHY.expired)
      }
      if (gate.kind === "login") {
        steps.push("login")
        await shooter.shot("login")
        return fail("login", NEEDS_WHY.login)
      }
      if (gate.kind === "review") {
        steps.push("review")
        if (!(await safeClick(gate.button, { expect: "Review Documents", log }))) return fail(null, "Review Documents button not clickable")
      } else if (gate.kind === "consent") {
        steps.push("consent")
        await gate.box.check({ timeout: 5_000 }).catch(() => gate.box.click({ timeout: 5_000 }))
        const btn = await continueButton(page)
        if (!btn || !(await safeClick(btn, { expect: "Continue", log }))) return fail(null, "consent ticked but no Continue button")
      } else if (gate.kind === "access_code") {
        if (!accessCode) {
          steps.push("access_code")
          await shooter.shot("access_code")
          return fail("access_code", NEEDS_WHY.access_code)
        }
        if (codeTried) {
          steps.push("access_code_rejected")
          await shooter.shot("access_code_rejected")
          return fail("access_code", "DocuSign rejected the access code")
        }
        codeTried = true
        steps.push("access_code")
        await gate.input.fill(String(accessCode), { timeout: 5_000 })
        const btn = await firstVisible(page, [(p) => p.getByRole("button", { name: /^(validate|continue)$/i }), (p) => p.locator('[data-qa*="validate" i], [data-qa*="continue" i]')], 1_500)
        if (!btn || !(await safeClick(btn, { expect: "Validate", log }))) await gate.input.press("Enter")
      }
      await settle(page)
      await shooter.shot(gate.kind)
    }
    log(`[fetch] docusign: ${steps.length ? steps.join(" → ") + " → " : ""}documents open`)
    const entry = await clickDownloadEntry(page, log)
    if (!entry) {
      await shooter.shot("no-download-control")
      return fail(null, "no download control found on the envelope page")
    }
    steps.push(`download(${entry})`)
    const { mode, file } = await downloadFromDialog(page, log)
    if (!file) {
      await shooter.shot("no-download")
      return fail(null, "download dialog did not produce a file")
    }
    steps.push(mode || "default")
    await shooter.shot("downloaded")
    const how = await finishLater(page, log)
    if (how) steps.push(how)
    log(`[fetch] docusign: ${steps.join(" → ")} → ${file.filename} (${file.bytes.length} bytes)`)
    return { ok: true, files: [file], screenshots: shooter.shots, steps }
  } catch (e) {
    await shooter.shot("error")
    return fail(null, e?.message || String(e))
  } finally {
    await close()
  }
}
