// Static assets with content-hash versioning. Phones cache /style.css and
// /sign.js hard (Safari kept a stale stylesheet for an hour after a deploy),
// so every asset URL carries ?v=<sha256 prefix> of the file's bytes and the
// server marks a correctly-versioned response immutable for a year. An
// unversioned (or stale-versioned) URL is served `no-cache`.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { APP_ROOT } from "./env.mjs"

export const PUBLIC_DIR = path.join(APP_ROOT, "public")
export const FONT_DIR = path.join(APP_ROOT, "assets", "fonts")

const MIME = {
  ".png": "image/png", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon", ".svg": "image/svg+xml",
}

const hashes = new Map() // url path → { file, hash }

function register(urlPath, file) {
  if (!fs.existsSync(file)) return
  const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12)
  hashes.set(urlPath, { file, hash })
}

/** Hash everything in public/ and the signature fonts once, at startup. */
export function loadAssets() {
  hashes.clear()
  for (const f of fs.readdirSync(PUBLIC_DIR)) if (MIME[path.extname(f)]) register(`/${f}`, path.join(PUBLIC_DIR, f))
  if (fs.existsSync(FONT_DIR)) for (const f of fs.readdirSync(FONT_DIR)) if (/\.(ttf|otf|woff2?)$/i.test(f)) register(`/fonts/${f}`, path.join(FONT_DIR, f))
  return hashes.size
}

/** `/style.css` → `/style.css?v=3f9a…` (unversioned if the file is unknown). */
export function asset(urlPath) {
  const a = hashes.get(urlPath)
  return a ? `${urlPath}?v=${a.hash}` : urlPath
}

export function assetHash(urlPath) {
  return hashes.get(urlPath)?.hash ?? null
}

/**
 * Response for a static asset. `v` is the ?v= query the client sent: when it
 * matches the current content hash the response is immutable; otherwise it is
 * `no-cache` so a stale link never pins an old file in a phone's cache.
 */
export function assetResponse(urlPath, v) {
  const a = hashes.get(urlPath)
  if (!a) return null
  const fresh = v && v === a.hash
  return new Response(fs.readFileSync(a.file), {
    headers: {
      "content-type": MIME[path.extname(a.file)] || "application/octet-stream",
      "cache-control": fresh ? "public, max-age=31536000, immutable" : "no-cache",
      "etag": `"${a.hash}"`,
    },
  })
}
