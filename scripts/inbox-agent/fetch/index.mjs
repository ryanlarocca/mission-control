// Inbox Agent — fetch documents from behind a link (briefs/BRIEF_INBOX_LINK_FETCH_2026-10-12.md).
//
//   fetchDocuments({ url, provider, accessCode, jobId, log, headed })
//     → { ok: true,  files: [{ filename, mime, bytes, kind?, pageText? }], screenshots: [paths], steps }
//       (kind + pageText only from FreshBooks: "staging_proposal" | "staging_invoice" and the rendered page's text)
//     → { ok: false, error, needs: "access_code" | "login" | "expired" | "new_link" | null, screenshots, steps }
//
// The dispatcher owns the cross-provider rules: the 90 s job cap, ZIP
// expansion (Separate PDFs come back as one ZIP), screenshot pruning, and the
// on-disk store that keeps the bytes for a later approval/undo (the
// attachment path re-reads Gmail; a fetched file has no attachment to re-read).
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { unzipSync } from "fflate"
import { JOB_TIMEOUT_MS, mimeFor, pruneScreenshots, withTimeout } from "./browser.mjs"
import { fetchDocuSign } from "./docusign.mjs"
import { F8_JOB_TIMEOUT_MS, fetchF8 } from "./f8.mjs"
import { TAPINSPECT_JOB_TIMEOUT_MS, fetchTapInspect } from "./tapinspect.mjs"
import { FRESHBOOKS_JOB_TIMEOUT_MS, fetchFreshBooks } from "./freshbooks.mjs"
import { addressIn, detectProvider, documentLinks, tapinspectShareId } from "./providers.mjs"
import { envelopeMatches } from "../loops.mjs"
import { keysMatch, propertyKey } from "../env.mjs"

export { addressIn, detectProvider, documentLinks, extractUrls, freshbooksKind, freshbooksNumber, propertyWebsiteLinks, providerKind, providerLabel, queuesForVendor, queuesOnSystemEmail, tapinspectShareId, unwrapTrackingUrl } from "./providers.mjs"
export { fetchF8, parseDownloadCenter, parseDownloadJson } from "./f8.mjs"
export { SELECTORS as TAPINSPECT_SELECTORS, fetchTapInspect, gateFromReportText, tapClickAllowed } from "./tapinspect.mjs"
export { SELECTORS as FRESHBOOKS_SELECTORS, fbClickAllowed, fetchFreshBooks, freshbooksAddress, freshbooksAmount, freshbooksGate, parseFreshbooksPage } from "./freshbooks.mjs"

/** Media jobs (f8: ~255 MB over 72 CDN downloads) get 10 min; document jobs keep the 90 s browser cap. */
export const MEDIA_JOB_TIMEOUT_MS = F8_JOB_TIMEOUT_MS

export const MAX_FETCH_ATTEMPTS = 3
/** Backoff before attempt n+1 (ms): 5 min after the first failure, 30 min after the second, then give up. */
export const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000]
export function nextTryAt(attempts, now = Date.now()) {
  const wait = RETRY_BACKOFF_MS[attempts - 1]
  return wait === undefined ? null : new Date(now + wait).toISOString()
}

// ---------------------------------------------------------------- Phase 1b: expired email links
// DocuSign email links expire. The flow clicks SEND NEW LINK (a fresh link is
// emailed to ryan@, the mailbox the agent reads) and the job parks as
// `awaiting_new_link` with no card. The fresh email is classified and queued
// like any other; when that job reaches `done` for the same envelope, the
// parked job becomes `resolved_by_new_link`. Two hours with no fresh link →
// the usual ⚠️ card, then `failed`. Never ask twice for the same envelope
// within 24 h — the rows below are the guard (pure, so the worker and the
// unit test agree). Statuses are free text: no migration.
export const NEW_LINK_ERROR = "asked DocuSign for a fresh link"
export const NEW_LINK_WAIT_MS = 2 * 60 * 60_000
export const NEW_LINK_GUARD_MS = 24 * 60 * 60_000

const ms = (iso) => (iso ? new Date(iso).getTime() : NaN)

/**
 * Same envelope = same Gmail thread, or the same normalized subject (the fresh
 * email may start a new thread). Synthetic `fetch <host>` subjects (typed
 * links) never match by subject — two manual pulls are not one envelope.
 * @param {{thread_id?: string|null, subject?: string|null}} a
 * @param {{thread_id?: string|null, subject?: string|null}} b
 */
export function sameEnvelope(a, b) {
  if (a?.thread_id && a.thread_id === b?.thread_id) return true
  const sa = String(a?.subject || "")
  const sb = String(b?.subject || "")
  if (/^fetch\s/i.test(sa) || /^fetch\s/i.test(sb)) return false
  return envelopeMatches(sa, sb)
}

/**
 * The row that already asked DocuSign for this envelope's fresh link in the
 * last 24 h (still waiting, or timed out), else null. `rows` are inbox_fetches
 * rows with `subject` folded in; `job` is the one about to run.
 */
export function newLinkGuard(job, rows, now = Date.now()) {
  return (rows || []).find((r) => r.id !== job.id && String(r.error || "").startsWith(NEW_LINK_ERROR) && ms(r.started_at) >= now - NEW_LINK_GUARD_MS && sameEnvelope(r, job)) || null
}

/** The `awaiting_new_link` rows a job reaching `done` closes (same envelope). */
export function waitsClosedBy(done, rows) {
  return (rows || []).filter((r) => r.id !== done.id && r.status === "awaiting_new_link" && sameEnvelope(r, done))
}

/** The `awaiting_new_link` rows that have waited more than 2 h (or carry no start time at all). */
export function waitsTimedOut(rows, now = Date.now()) {
  return (rows || []).filter((r) => r.status === "awaiting_new_link" && !(ms(r.started_at) > now - NEW_LINK_WAIT_MS))
}

// ---------------------------------------------------------------- Part B4/B5: HomeSentry's payment gate
// HomeSentry's flow is invoice → signed agreement → report viewable. When the
// fetch finds the report not viewable yet, the job parks as `awaiting_payment`
// (no card — the email already runs the "sign / pay" loop) and retries daily
// via next_try_at; each daily retry is one attempt, 14 attempts = 14 days,
// then `expired` with one card. A wake (a new HomeSentry email carrying the
// same share uuid, or a payment/updated/results subject for the same property;
// a `fetch` reply; 🔁 Retry) puts the row back on the queue with attempts 0.
// HomeSentry reuses the SAME share URL for "results have been updated", and
// `inbox_fetches_url_once` is unique on url_sha256 — so a link that already
// has a row is requeued (never inserted twice) when its job is finished or
// parked, and left alone while it is queued/running. Statuses are free text.
export const AWAITING_PAYMENT_ERROR = "report not viewable yet (payment/agreement pending)"
export const AWAITING_PAYMENT_RETRY_MS = 24 * 60 * 60_000
export const AWAITING_PAYMENT_MAX_TRIES = 14
export const TAPINSPECT_SENDER_RE = /@tapinspect\.com$/i
export const TAPINSPECT_WAKE_SUBJECT_RE = /payment|updated|results/i
const REQUEUE_FROM = new Set(["done", "awaiting_payment", "failed", "expired"])

/**
 * After a gated run: park for another day, or give up after 14 tries.
 * `attempts` = the attempt that just ran (the worker increments before running).
 * @returns {{ status: "awaiting_payment", next_try_at: string, attempts: number, error: string } | { status: "expired", attempts: number, error: string }}
 */
export function awaitingPaymentNext(attempts, now = Date.now()) {
  const n = Math.max(1, Number(attempts) || 1)
  if (n >= AWAITING_PAYMENT_MAX_TRIES) return { status: "expired", attempts: n, error: `${AWAITING_PAYMENT_ERROR} — report never released in ${AWAITING_PAYMENT_MAX_TRIES} days` }
  return { status: "awaiting_payment", next_try_at: new Date(now + AWAITING_PAYMENT_RETRY_MS).toISOString(), attempts: n, error: AWAITING_PAYMENT_ERROR }
}

/** The subjects that mean a new version of an already-filed report ("results … have been updated"). */
export const TAPINSPECT_UPDATED_SUBJECT_RE = /updated|revised|new version|re-?issued/i

/** B5: what to do when a link's url_sha256 already has a row. A `done` report is
 *  fetched again only when the email says the results were UPDATED — live 2026-10-16
 *  Amanda forwarded the first results email and the watcher re-pulled the same PDF. */
export function requeueDecision(existing, provider, subject = "") {
  if (!existing) return "insert"
  if (provider !== "tapinspect" || !REQUEUE_FROM.has(existing.status)) return "leave"
  if (existing.status === "done" && !TAPINSPECT_UPDATED_SUBJECT_RE.test(String(subject || ""))) return "leave"
  return "requeue"
}

/**
 * B4 wake rule (a): the parked `awaiting_payment` rows a new email wakes —
 * from a tapinspect sender, carrying the same share uuid (body or classifier
 * links), or a payment / updated / results subject for the same property.
 * `rows` carry the parked job's own email folded in (`subject`,
 * `property_label` from its classification). Pure.
 * @param {{ from?: {email?: string}, subject?: string, text?: string }} msg
 * @param {{ document_links?: string[], property?: {label?: string}|null }|null} cls
 * @param {Array<{ id: string, status: string, provider: string, url: string, subject?: string|null, property_label?: string|null }>} rows
 */
export function paymentWakeTargets(msg, cls, rows) {
  const parked = (rows || []).filter((r) => r.status === "awaiting_payment" && r.provider === "tapinspect")
  if (!parked.length) return []
  const sender = String(msg?.from?.email || "").toLowerCase()
  if (!TAPINSPECT_SENDER_RE.test(sender)) return []
  const ids = new Set(documentLinks(msg, Array.isArray(cls?.document_links) ? cls.document_links : []).map((l) => tapinspectShareId(l.url)).filter(Boolean))
  const subjectHit = TAPINSPECT_WAKE_SUBJECT_RE.test(String(msg?.subject || ""))
  const key = propertyKey(cls?.property?.label || addressIn(msg?.subject) || "")
  return parked.filter((r) => {
    const share = tapinspectShareId(r.url)
    if (share && ids.has(share)) return true
    if (!subjectHit || !key) return false
    const rk = propertyKey(r.property_label || addressIn(r.subject) || "")
    return !!rk && keysMatch(rk, key)
  })
}

// ---------------------------------------------------------------- zip
const SKIP_ENTRY_RE = /(^|\/)(__MACOSX|\.DS_Store|thumbs\.db)(\/|$)|\/$/i

/** A downloaded ZIP → [{filename, mime, bytes}], one per real file entry (basename only). */
export function unzipToFiles(zipBytes) {
  const entries = unzipSync(new Uint8Array(zipBytes))
  const out = []
  const seen = new Map()
  for (const [name, data] of Object.entries(entries)) {
    if (SKIP_ENTRY_RE.test(name) || !data.length) continue
    let filename = path.posix.basename(name)
    const n = (seen.get(filename) || 0) + 1
    seen.set(filename, n)
    if (n > 1) filename = filename.replace(/(\.[a-z0-9]+)?$/i, ` (${n})$1`)
    const bytes = Buffer.from(data)
    out.push({ filename, mime: mimeFor(filename, bytes), bytes })
  }
  return out
}

/** Expand ZIP downloads, keep the rest as-is. */
export function expandDownloads(files) {
  const out = []
  for (const f of files || []) {
    const isZip = f.mime === "application/zip" || /\.zip$/i.test(f.filename || "") || Buffer.from(f.bytes.subarray(0, 4)).toString("latin1").startsWith("PK\u0003\u0004")
    if (!isZip) {
      out.push({ ...f, mime: mimeFor(f.filename, f.bytes) })
      continue
    }
    try {
      out.push(...unzipToFiles(f.bytes))
    } catch (e) {
      out.push({ ...f, mime: "application/zip", unzipError: e?.message || String(e) })
    }
  }
  return out
}

// ---------------------------------------------------------------- on-disk store
export const FETCH_STORE = process.env.INBOX_FETCH_STORE || path.join(os.homedir(), ".lrg", "inbox-fetch")
export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}
/** Where a fetched file's bytes live: <store>/<fetchId>/<sha256>. inbox_files has both columns, so no new column. */
export function fetchedFilePath(fetchId, sha, root = FETCH_STORE) {
  return path.join(root, String(fetchId).replace(/[^a-z0-9_.-]/gi, "_"), String(sha))
}
export function saveFetchedBytes(fetchId, bytes, root = FETCH_STORE) {
  const file = fetchedFilePath(fetchId, sha256(bytes), root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
  return file
}
export function readFetchedBytes(fetchId, sha, root = FETCH_STORE) {
  const file = fetchedFilePath(fetchId, sha, root)
  if (!fs.existsSync(file)) throw new Error(`fetched file missing on disk: ${file}`)
  return fs.readFileSync(file)
}

// ---------------------------------------------------------------- dispatcher
/**
 * Documents come back as `files`; media (f8 photos) as `sets` — no ZIP
 * expansion, no screenshots, no browser on that path.
 * @param {{ url: string, provider?: string|null, accessCode?: string|null, jobId?: string, log?: Function, headed?: boolean, timeoutMs?: number|null, sendNewLink?: boolean, fetchImpl?: typeof fetch }} job
 */
export async function fetchDocuments({ url, provider = null, accessCode = null, jobId = `job-${Date.now()}`, log = () => {}, headed = false, timeoutMs = null, sendNewLink = true, fetchImpl = fetch }) {
  const p = provider || detectProvider(url)
  if (p === "f8") {
    const budget = timeoutMs ?? MEDIA_JOB_TIMEOUT_MS
    let r
    try {
      r = await withTimeout(fetchF8({ url, jobId, log, fetchImpl, timeoutMs: budget }), budget, `fetch ${jobId}`)
    } catch (e) {
      return { ok: false, error: e?.message || String(e), needs: null, screenshots: [], steps: [] }
    }
    if (r.ok) log(`[fetch] ${p}: ${r.steps.join(" → ")} → ${r.sets.map((s) => `${s.set} ${s.files.length}`).join(" · ")}`)
    return { ...r, screenshots: [] }
  }
  if (p !== "docusign" && p !== "tapinspect" && p !== "freshbooks") return { ok: false, error: `no fetcher for ${p || "that link"}`, needs: null, screenshots: [], steps: [] }
  timeoutMs = timeoutMs ?? (p === "tapinspect" ? TAPINSPECT_JOB_TIMEOUT_MS : p === "freshbooks" ? FRESHBOOKS_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS)
  try {
    pruneScreenshots()
  } catch {}
  let r
  try {
    const flow = p === "tapinspect" ? fetchTapInspect({ url, jobId, log, headed }) : p === "freshbooks" ? fetchFreshBooks({ url, jobId, log, headed }) : fetchDocuSign({ url, accessCode, jobId, log, headed, sendNewLink })
    r = await withTimeout(flow, timeoutMs, `fetch ${jobId}`)
  } catch (e) {
    return { ok: false, error: e?.message || String(e), needs: null, screenshots: [], steps: [] }
  }
  if (!r.ok) return r
  const files = expandDownloads(r.files)
  log(`[fetch] ${p}: ${r.steps.join(" → ")} → ${files.length} file${files.length === 1 ? "" : "s"}${files.map((f) => ` · ${f.filename}`).join("")}`)
  return { ...r, files }
}
