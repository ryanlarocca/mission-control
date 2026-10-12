// Inbox Agent — fetch documents from behind a link (briefs/BRIEF_INBOX_LINK_FETCH_2026-10-12.md).
//
//   fetchDocuments({ url, provider, accessCode, jobId, log, headed })
//     → { ok: true,  files: [{ filename, mime, bytes }], screenshots: [paths], steps }
//     → { ok: false, error, needs: "access_code" | "login" | "expired" | null, screenshots, steps }
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
import { detectProvider } from "./providers.mjs"

export { detectProvider, documentLinks, extractUrls, providerLabel } from "./providers.mjs"

export const MAX_FETCH_ATTEMPTS = 3
/** Backoff before attempt n+1 (ms): 5 min after the first failure, 30 min after the second, then give up. */
export const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000]
export function nextTryAt(attempts, now = Date.now()) {
  const wait = RETRY_BACKOFF_MS[attempts - 1]
  return wait === undefined ? null : new Date(now + wait).toISOString()
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
 * @param {{ url: string, provider?: string|null, accessCode?: string|null, jobId?: string, log?: Function, headed?: boolean, timeoutMs?: number }} job
 */
export async function fetchDocuments({ url, provider = null, accessCode = null, jobId = `job-${Date.now()}`, log = () => {}, headed = false, timeoutMs = JOB_TIMEOUT_MS }) {
  const p = provider || detectProvider(url)
  if (p !== "docusign") return { ok: false, error: `no fetcher for ${p || "that link"}`, needs: null, screenshots: [], steps: [] }
  try {
    pruneScreenshots()
  } catch {}
  let r
  try {
    r = await withTimeout(fetchDocuSign({ url, accessCode, jobId, log, headed }), timeoutMs, `fetch ${jobId}`)
  } catch (e) {
    return { ok: false, error: e?.message || String(e), needs: null, screenshots: [], steps: [] }
  }
  if (!r.ok) return r
  const files = expandDownloads(r.files)
  log(`[fetch] ${p}: ${r.steps.join(" → ")} → ${files.length} file${files.length === 1 ? "" : "s"}${files.map((f) => ` · ${f.filename}`).join("")}`)
  return { ...r, files }
}
