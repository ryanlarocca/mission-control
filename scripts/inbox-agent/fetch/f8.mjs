// Inbox Agent — listing photos from an f8 Real Estate Media delivery
// (briefs/BRIEF_INBOX_MEDIA_DELIVERY_2026-10-15.md §2).
//
//   fetchF8({ url, jobId, log, fetchImpl })
//     → { ok: true,  sets: [{ set: "MLS"|"Print", files: [{ filename, mime, bytes, imageId }] }],
//          counts: { page, mls, print }, listingId, groups, steps }
//     → { ok: false, error, needs: "expired" | "login" | null, steps }
//
// f8 runs on Aryeo. The Download Center is a server-rendered Laravel page
// (verified with curl on 2026-10-15 — no browser, no account, no Playwright):
//   1. GET the Download Center → HTML with a CSRF `_token` input and, per image
//      group, two forms whose x-on:submit call
//      fetchDownloadLinks($event, '<groupUrl>', 'https://foundry.aryeo.com/api/zip')
//      for …/image-groups/<group>/download/print and …/download/web. The
//      response sets XSRF-TOKEN + aryeo_session cookies.
//   2. POST each group URL with multipart `_token`, the cookies, Accept JSON,
//      X-Requested-With → { zip_name, download_data: [{ download_type: "url",
//      name: "images-for-web-or-mls/1-001_F8_5764 Halleck Dr.JPG", path:
//      "https://cdn.aryeo.com/listings/<slug>/resized/large/large-<imageId>.jpeg" }] }.
//      The print set's `path` is the un-resized original; the image UUID is the
//      same for both copies of one photo.
//   3. GET every `path` — public CDN, no cookies. The site's own zip endpoint is
//      never used: files are named by the basename of `name`.
//
// Ryan's decisions: both sets, photographer filenames kept, never a partial
// set (count mismatch → the job fails with a precise error and nothing is
// filed). Both sets are held in RAM (~255 MB for 36 photos — fine on the mini)
// so index.mjs can hash, dedupe and upload straight from the result.
import { mimeFor } from "./browser.mjs"

export const F8_REQUEST_TIMEOUT_MS = 30_000
export const F8_IMAGE_TRIES = 3
export const F8_CONCURRENCY = 4
export const F8_JOB_TIMEOUT_MS = 10 * 60_000

const SET_FOR = { web: "MLS", print: "Print" }
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const CDN_HOST_RE = /^(cdn\.aryeo\.com|([a-z0-9-]+\.)*aryeo\.com)$/i

// ---------------------------------------------------------------- pure parsers
function decodeEntities(s) {
  return String(s || "").replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#x27;/gi, "'").replace(/&amp;/g, "&")
}

/** The Laravel CSRF token: `<input type="hidden" name="_token" value="…">` (attribute order varies). */
function tokenFrom(html) {
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0]
    if (!/\bname\s*=\s*["']_token["']/i.test(tag)) continue
    const v = /\bvalue\s*=\s*["']([^"']+)["']/i.exec(tag)
    if (v) return v[1]
  }
  return null
}

/**
 * Parse the Download Center page (pure).
 * @param {string} html
 * @returns {{ token: string|null, groups: Array<{group: string, webUrl: string|null, printUrl: string|null}>, imageCount: number|null, counts: {web: number|null, print: number|null}, needs: "login"|null, error: string|null, otherAssets: string[] }}
 */
export function parseDownloadCenter(html) {
  const page = decodeEntities(String(html || ""))
  const token = tokenFrom(page)
  const groups = new Map()
  // x-on:submit.prevent="fetchDownloadLinks($event, '<groupUrl>', '<zipUrl>')"
  for (const m of page.matchAll(/fetchDownloadLinks\(\s*\$event\s*,\s*(['"])([^'"]+)\1/g)) {
    const groupUrl = m[2]
    const g = /\/image-groups\/([^/]+)\/download\/(print|web)\/?$/i.exec(groupUrl)
    if (!g) continue
    const name = decodeURIComponent(g[1])
    const entry = groups.get(name) || { group: name, webUrl: null, printUrl: null }
    entry[g[2].toLowerCase() === "web" ? "webUrl" : "printUrl"] = groupUrl
    groups.set(name, entry)
  }
  // "Images (36)" is the group heading; the per-set labels repeat the number.
  const heading = /(?:^|>)\s*Images\s*\((\d+)\)/i.exec(page) || /\bImages\s*\((\d+)\)/i.exec(page)
  const imageCount = heading ? Number(heading[1]) : null
  const web = /Web\s*\/\s*MLS\s*Quality\s*Images\s*\((\d+)\)/i.exec(page)
  const print = /Print\s*Quality\s*Images\s*\((\d+)\)/i.exec(page)
  // Out of scope but worth a log line: video / floor plan / Matterport / tour groups.
  const otherAssets = [...new Set([...page.matchAll(/\/(videos?|floor-?plans?|matterport|tours?|virtual-tours?)\//gi)].map((m) => m[1].toLowerCase()))]
  const hasLoginForm = /type\s*=\s*["']password["']/i.test(page) || /<form\b[^>]*action\s*=\s*["'][^"']*\/(login|portal\/login)\b/i.test(page)
  let needs = null
  let error = null
  if (!token || !groups.size) {
    if (hasLoginForm) {
      needs = "login"
      error = "f8 wants a login"
    } else error = !token ? "no _token on the Download Center page" : "no image-group download forms on the Download Center page"
  }
  return { token, groups: [...groups.values()], imageCount, counts: { web: web ? Number(web[1]) : null, print: print ? Number(print[1]) : null }, needs, error, otherAssets }
}

/**
 * Parse one image-group download response (pure).
 * @param {{ download_data?: Array<{download_type?: string, name?: string, path?: string, type?: string}> }} json
 * @param {"MLS"|"Print"} set
 * @returns {Array<{ filename: string, url: string, imageId: string, set: "MLS"|"Print" }>}
 */
export function parseDownloadJson(json, set) {
  const out = []
  for (const d of Array.isArray(json?.download_data) ? json.download_data : []) {
    if (d?.download_type !== "url" || !d.path || !d.name) continue
    let u
    try {
      u = new URL(String(d.path))
    } catch {
      continue
    }
    if (u.protocol !== "https:" || !CDN_HOST_RE.test(u.hostname)) continue
    const filename = String(d.name).split("/").filter(Boolean).at(-1)
    if (!filename) continue
    const idm = UUID_RE.exec(u.pathname.split("/").at(-1) || "")
    if (!idm) continue
    out.push({ filename, url: u.href, imageId: idm[0].toLowerCase(), set })
  }
  return out
}

/** The listing id in a Download Center URL. */
export function listingIdFrom(url) {
  const m = /\/listings\/([^/?#]+)\/download-center/i.exec(String(url || ""))
  return m ? m[1] : null
}

// ---------------------------------------------------------------- cookie jar (two cookies)
export function parseSetCookies(headers) {
  const raw = typeof headers?.getSetCookie === "function" ? headers.getSetCookie() : []
  if (!raw.length) {
    const one = headers?.get?.("set-cookie")
    // A joined header: split on commas that start a new `name=` pair (Expires dates carry commas too).
    if (one) raw.push(...String(one).split(/,(?=\s*[A-Za-z0-9_.-]+=)/))
  }
  const jar = new Map()
  for (const c of raw) {
    const first = String(c).split(";")[0]
    const eq = first.indexOf("=")
    if (eq <= 0) continue
    jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim())
  }
  return jar
}
export function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
}

// ---------------------------------------------------------------- flow
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 LRG-inbox-agent"

function signalFor(ms, parent) {
  const t = AbortSignal.timeout(ms)
  return parent && typeof AbortSignal.any === "function" ? AbortSignal.any([parent, t]) : t
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

async function downloadImage(entry, { fetchImpl, signal, requestTimeoutMs, tries, log }) {
  let lastErr = "no attempt"
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetchImpl(entry.url, { headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.8" }, signal: signalFor(requestTimeoutMs, signal) })
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`
      } else {
        const bytes = Buffer.from(await res.arrayBuffer())
        const mime = mimeFor(entry.filename, bytes)
        if (!bytes.length) lastErr = "empty body"
        else if (!/^image\//.test(mime)) lastErr = `not an image (${mime})`
        else return { ok: true, file: { filename: entry.filename, mime, bytes, imageId: entry.imageId } }
      }
    } catch (e) {
      lastErr = e?.name === "AbortError" || e?.name === "TimeoutError" ? `timed out after ${Math.round(requestTimeoutMs / 1000)}s` : e?.message || String(e)
    }
    if (attempt < tries) log(`[fetch] f8: ${entry.set} ${entry.filename} attempt ${attempt} failed (${lastErr}) — retrying`)
  }
  return { ok: false, error: lastErr, entry }
}

/** @typedef {{ filename: string, mime: string, bytes: Buffer, imageId: string }} F8File */
/** @typedef {{ ok: true, sets: Array<{ set: "MLS"|"Print", files: F8File[] }>, counts: { page: number, mls: number, print: number }, listingId: string|null, groups: string[], steps: string[] }} F8Ok */
/** @typedef {{ ok: false, error: string, needs: "expired"|"login"|null, steps: string[] }} F8Fail */

/**
 * @param {{ url: string, jobId?: string, log?: Function, fetchImpl?: typeof fetch, timeoutMs?: number, requestTimeoutMs?: number, tries?: number, concurrency?: number }} job
 * @returns {Promise<F8Ok|F8Fail>}
 */
export async function fetchF8({ url, jobId = `job-${Date.now()}`, log = () => {}, fetchImpl = fetch, timeoutMs = F8_JOB_TIMEOUT_MS, requestTimeoutMs = F8_REQUEST_TIMEOUT_MS, tries = F8_IMAGE_TRIES, concurrency = F8_CONCURRENCY }) {
  /** @type {string[]} */
  const steps = []
  /** @returns {F8Fail} */
  const fail = (error, needs = null) => ({ ok: false, error, needs, steps })
  const listingId = listingIdFrom(url)
  const jobSignal = AbortSignal.timeout(timeoutMs)

  // 1. The Download Center page + its cookies.
  let res
  try {
    res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal: signalFor(requestTimeoutMs, jobSignal) })
  } catch (e) {
    return fail(`Download Center unreachable: ${e?.message || e}`)
  }
  steps.push(`open ${res.status}`)
  const jar = parseSetCookies(res.headers)
  if (res.status === 403 || res.status === 410) return fail(`f8 answered ${res.status} for the Download Center — the link looks expired`, "expired")
  const html = await res.text().catch(() => "")
  if (!res.ok) return fail(`f8 answered ${res.status} for the Download Center`)
  const page = parseDownloadCenter(html)
  if (page.error) {
    if (page.needs === "login") return fail(page.error, "login")
    if (/\bexpired\b|no longer available/i.test(html)) return fail("f8 says the Download Center link has expired", "expired")
    return fail(page.error)
  }
  if (page.otherAssets.length) log(`[fetch] f8: page also carries ${page.otherAssets.join(", ")} assets — out of scope, photos only`)
  steps.push(`parse ${page.groups.length} group${page.groups.length === 1 ? "" : "s"} (${page.groups.map((g) => g.group).join(", ")}) · ${page.imageCount ?? "?"} images`)
  if (page.imageCount == null) return fail("could not read the image count (`Images (N)`) from the Download Center page")

  // 2. The per-set file lists.
  const lists = { MLS: [], Print: [] }
  for (const g of page.groups) {
    for (const [key, groupUrl] of [["web", g.webUrl], ["print", g.printUrl]]) {
      const set = SET_FOR[key]
      if (!groupUrl) return fail(`group ${g.group} has no ${set} download form`)
      const form = new FormData()
      form.append("_token", page.token)
      let r
      try {
        r = await fetchImpl(groupUrl, {
          method: "POST",
          body: form,
          headers: { "User-Agent": UA, Accept: "application/json", "X-Requested-With": "XMLHttpRequest", Referer: url, Origin: new URL(url).origin, Cookie: cookieHeader(jar) },
          signal: signalFor(requestTimeoutMs, jobSignal),
        })
      } catch (e) {
        return fail(`${set} list for group ${g.group}: ${e?.message || e}`)
      }
      for (const [k, v] of parseSetCookies(r.headers)) jar.set(k, v)
      if (!r.ok) return fail(`${set} list for group ${g.group}: HTTP ${r.status}${r.status === 419 ? " (CSRF token rejected)" : ""}`)
      let json
      try {
        json = await r.json()
      } catch {
        return fail(`${set} list for group ${g.group}: not JSON`)
      }
      const entries = parseDownloadJson(json, set)
      steps.push(`${set} list ${entries.length}`)
      lists[set].push(...entries)
    }
  }

  // 3. Every image, both sets, concurrency 4, 3 tries each.
  const all = [...lists.MLS, ...lists.Print]
  const results = await mapLimit(all, concurrency, (entry) => downloadImage(entry, { fetchImpl, signal: jobSignal, requestTimeoutMs, tries, log }))
  // `results` is positional (MLS entries first, then Print), so the split is exact.
  /** @type {Array<{ set: "MLS"|"Print", files: F8File[] }>} */
  const sets = [
    { set: "MLS", files: results.slice(0, lists.MLS.length).filter((r) => r.ok).map((r) => r.file) },
    { set: "Print", files: results.slice(lists.MLS.length).filter((r) => r.ok).map((r) => r.file) },
  ]
  const failed = results.filter((r) => !r.ok)
  for (const f of failed) log(`[fetch] f8: ${f.entry.set} ${f.entry.filename} failed after ${tries} tries — ${f.error}`)
  steps.push(`download ${results.length - failed.length}/${results.length}`)
  const counts = { page: page.imageCount, mls: sets[0].files.length, print: sets[1].files.length }
  for (const s of sets) {
    if (s.files.length !== page.imageCount) {
      const firstErr = failed.find((f) => f.entry.set === s.set)
      return fail(`${s.set} set: ${s.files.length} of ${page.imageCount} images downloaded${firstErr ? ` (${firstErr.entry.filename}: ${firstErr.error})` : ""}`)
    }
  }
  const bytes = all.length ? results.reduce((n, r) => n + (r.ok ? r.file.bytes.length : 0), 0) : 0
  log(`[fetch] f8: ${counts.mls} MLS + ${counts.print} Print images · ${(bytes / 1024 / 1024).toFixed(1)} MB`)
  return { ok: true, sets, counts, listingId, groups: page.groups.map((g) => g.group), steps }
}
