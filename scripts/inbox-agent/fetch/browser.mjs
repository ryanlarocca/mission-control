// Inbox Agent — the headless Chrome behind link fetches.
//
// One persistent Chrome profile (outside the repo) so that once Ryan logs
// into DocuSign there — later, `--headed --login` — the consent screens stop
// and any envelope sent to ryan@ opens. v1 works without a login: recipient
// links open on their own. Google Chrome via `channel: "chrome"`, the same
// pattern as scripts/skip-trace-fps.mjs — there is no ms-playwright download
// cache on the mini, never rely on bundled Chromium.
//
// Ryan accepted two side effects (2026-10-12): the envelope shows as Viewed
// to the sender, and the agent ticks the e-records consent box. The agent
// must never sign, adopt a signature, finish, decline, or submit anything —
// every click goes through isAllowedClick() below.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const JOB_TIMEOUT_MS = 90_000
export const SCREENSHOT_ROOT = process.env.INBOX_FETCH_SCREENSHOTS || "/tmp/inbox-fetch"
export const KEEP_JOBS = 50

// ---------------------------------------------------------------- click allowlist
// The only buttons/links the flow may click. Matched against the visible
// text (or data-qa) of the element, case-insensitively, as a whole label.
export const CLICK_ALLOW = [
  /^continue$/i,
  /^review documents?$/i,
  /^other actions$/i,
  /^(print\s*(&|and)\s*)?download$/i,
  /^print\s*(&|and)\s*download$/i,
  /^(combined|separate)( pdfs?| documents?| files?)?$/i,
  /^download (combined|separate)( pdfs?)?$/i,
  /^close$/i,
  /^finish later$/i,
  /^got it$/i,
  /^ok(ay)?$/i,
  /^validate$/i, // the access-code form's submit button (DocuSign names it VALIDATE, not Continue)
  /^send new link$/i, // the expired-link page (Phase 1b): emails a fresh link to ryan@, nothing else
]
// Anything here is refused even if it also matches the allowlist.
export const CLICK_REFUSE = /sign|adopt|finish(?! later)|submit|decline|agree and sign|complete/i

/** Normalise a label: collapse whitespace, strip icons and trailing ellipses. */
function cleanLabel(label) {
  return String(label || "").replace(/[……]+$/g, "").replace(/[^\p{L}\p{N}&\s]/gu, " ").replace(/\s+/g, " ").trim()
}

/** {ok:true} when the flow may click an element with this label; {ok:false, why} otherwise. */
export function isAllowedClick(label) {
  const l = cleanLabel(label)
  if (!l) return { ok: false, why: "empty label" }
  if (CLICK_REFUSE.test(l)) return { ok: false, why: `refused: "${l}" matches ${CLICK_REFUSE}` }
  if (!CLICK_ALLOW.some((re) => re.test(l))) return { ok: false, why: `not on the allowlist: "${l}"` }
  return { ok: true }
}

// ---------------------------------------------------------------- profile + screenshots
export function profileDir() {
  const dir = process.env.INBOX_BROWSER_PROFILE || path.join(os.homedir(), ".lrg", "browser-profiles", "inbox-agent")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Keep the newest `keep` job directories under `root`; delete the rest. Returns the removed names. */
export function pruneScreenshots(root = SCREENSHOT_ROOT, keep = KEEP_JOBS) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return []
  }
  const dated = entries.map((d) => {
    const full = path.join(root, d.name)
    let mtime = 0
    try {
      mtime = fs.statSync(full).mtimeMs
    } catch {}
    return { name: d.name, full, mtime }
  }).sort((a, b) => b.mtime - a.mtime)
  const removed = []
  for (const d of dated.slice(keep)) {
    try {
      fs.rmSync(d.full, { recursive: true, force: true })
      removed.push(d.name)
    } catch {}
  }
  return removed
}

/** Screenshot after every step → /tmp/inbox-fetch/<jobId>/<n>-<step>.png. */
export function makeShooter(page, jobId) {
  const dir = path.join(SCREENSHOT_ROOT, String(jobId).replace(/[^a-z0-9_.-]/gi, "_"))
  fs.mkdirSync(dir, { recursive: true })
  let n = 0
  const shots = []
  const shot = async (step) => {
    n++
    const file = path.join(dir, `${String(n).padStart(2, "0")}-${String(step).replace(/[^a-z0-9_-]/gi, "_")}.png`)
    try {
      await page.screenshot({ path: file, fullPage: false })
      shots.push(file)
    } catch {}
    return file
  }
  return { shot, shots, dir, last: () => shots.at(-1) || null }
}

// ---------------------------------------------------------------- browser
/** Launch the persistent Chrome context. Returns {context, page, close}. */
export async function openBrowser({ headed = false, timeoutMs = 30_000 } = {}) {
  const { chromium } = await import("playwright")
  const context = await chromium.launchPersistentContext(profileDir(), {
    channel: "chrome",
    headless: !headed,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    timeout: timeoutMs,
  })
  context.setDefaultTimeout(Math.min(timeoutMs, 15_000))
  const page = context.pages()[0] || (await context.newPage())
  const close = async () => {
    await context.close().catch(() => {})
  }
  return { context, page, close }
}

/** Every label a locator carries (visible text, aria-label, data-qa, title, value), each on its own. */
export async function labelsOf(locator) {
  const out = []
  try {
    const text = (await locator.innerText({ timeout: 2_000 }).catch(() => "")) || ""
    if (text.trim()) out.push(text)
    const attrs = await locator.evaluate((el) => [el.getAttribute("aria-label"), el.getAttribute("data-qa"), el.getAttribute("title"), el.getAttribute("value")], { timeout: 2_000 }).catch(() => [])
    for (const a of attrs || []) if (a && String(a).trim()) out.push(String(a))
  } catch {}
  return out
}
/** Visible label of a locator (text, aria-label, data-qa, title) for the allowlist check. */
export async function labelOf(locator) {
  return (await labelsOf(locator)).join(" ")
}

/**
 * The allowlist over several candidate labels: any candidate on the refuse
 * list refuses the click; otherwise any single candidate on the allowlist
 * allows it. First live run (2026-10-12, Ridgeview): the button's visible text
 * came back empty and the joined attributes read "expired content send new
 * link button Send New Link", which no whole-label pattern matches — each
 * label has to be judged on its own.
 */
export function isAllowedClickAny(labels) {
  const list = (Array.isArray(labels) ? labels : [labels]).map(cleanLabel).filter(Boolean)
  if (!list.length) return { ok: false, why: "empty label" }
  for (const l of list) if (CLICK_REFUSE.test(l)) return { ok: false, why: `refused: "${l}" matches ${CLICK_REFUSE}` }
  for (const l of list) if (CLICK_ALLOW.some((re) => re.test(l))) return { ok: true }
  return { ok: false, why: `not on the allowlist: ${list.map((l) => `"${l}"`).join(" / ")}` }
}

/**
 * Click only if the element's label is on the allowlist. `expect` is what the
 * caller believes the label is (logged on refusal). Returns true when clicked.
 */
export async function safeClick(locator, { expect = "", log = () => {}, timeout = 8_000 } = {}) {
  const labels = await labelsOf(locator)
  const check = isAllowedClickAny(labels.length ? labels : [expect])
  if (!check.ok) {
    log(`[fetch] click refused (${check.why})${expect ? ` — wanted "${expect}"` : ""}`)
    return false
  }
  await locator.click({ timeout })
  return true
}

/** Race a step against the job budget. */
export function withTimeout(promise, ms, what = "job") {
  let t
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([promise, timer]).finally(() => clearTimeout(t))
}

/**
 * Run `trigger` (a click) and capture the download it starts.
 * Returns {filename, mime, bytes} or null when nothing downloaded in time.
 */
export async function captureDownload(page, trigger, { timeout = 30_000 } = {}) {
  const waiting = page.waitForEvent("download", { timeout }).catch(() => null)
  await trigger()
  const dl = await waiting
  if (!dl) return null
  const file = await dl.path()
  if (!file) {
    const err = await dl.failure().catch(() => null)
    throw new Error(`download failed${err ? `: ${err}` : ""}`)
  }
  const bytes = fs.readFileSync(file)
  const filename = dl.suggestedFilename() || path.basename(file)
  return { filename, mime: mimeFor(filename, bytes), bytes }
}

/** MIME from the extension, with a magic-byte check for PDFs and ZIPs. */
export function mimeFor(filename, bytes) {
  const head = bytes ? Buffer.from(bytes.subarray(0, 4)).toString("latin1") : ""
  if (head.startsWith("%PDF")) return "application/pdf"
  if (head.startsWith("PK\u0003\u0004")) return "application/zip"
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(filename || "") || [])[1]?.toLowerCase()
  return { pdf: "application/pdf", zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" }[ext] || "application/octet-stream"
}
