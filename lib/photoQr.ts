import jsQR from "jsqr"
import * as jpeg from "jpeg-js"
import { PNG } from "pngjs"

// QR codes in Telegram photos (2026-11-18, "photo brain"). Ryan photographs
// someone's phone showing a digital business card (Blinq / Popl / HiHello) —
// the QR is decoded here, in code, and its payload (a vCard, a MECARD, or a
// link to the card page) is handed to the planner as text. Pure JS: jsQR +
// jpeg-js + pngjs, no native image library on Vercel.
//
// Nothing here may fail the photo job: every error comes back as a note.

export interface Rgba {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** Decode a JPEG / PNG buffer to RGBA. null for other formats or a bad file. */
export function decodeToRgba(buf: Buffer): Rgba | null {
  try {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const png = PNG.sync.read(buf)
      return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height }
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 60, maxMemoryUsageInMB: 768, tolerantDecoding: true })
      return { data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), width: img.width, height: img.height }
    }
  } catch {
    return null
  }
  return null
}

/** Half-size copy (2×2 box average) — jsQR often finds a code in a big phone
 *  photo only once the sensor noise is averaged out. */
export function downscale2x(img: Rgba): Rgba {
  const w = Math.floor(img.width / 2)
  const h = Math.floor(img.height / 2)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        const i = (sx: number, sy: number) => img.data[(sy * img.width + sx) * 4 + c]
        out[(y * w + x) * 4 + c] = (i(2 * x, 2 * y) + i(2 * x + 1, 2 * y) + i(2 * x, 2 * y + 1) + i(2 * x + 1, 2 * y + 1)) >> 2
      }
    }
  }
  return { data: out, width: w, height: h }
}

/** The middle `frac` of the image (both axes) — a phone held up to the camera
 *  usually sits in the centre with a lot of table/background around it. */
export function centerCrop(img: Rgba, frac = 0.5): Rgba {
  const w = Math.max(1, Math.floor(img.width * frac))
  const h = Math.max(1, Math.floor(img.height * frac))
  const x0 = Math.floor((img.width - w) / 2)
  const y0 = Math.floor((img.height - h) / 2)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4
    out.set(img.data.subarray(src, src + w * 4), y * w * 4)
  }
  return { data: out, width: w, height: h }
}

function scan(img: Rgba): string | null {
  if (img.width < 21 || img.height < 21) return null
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })
  return code?.data ? code.data : null
}

/** Every QR payload found in the image (usually 0 or 1). Tries the full
 *  image, then a 2× downscale, then the centre crop (and its downscale). */
export function decodeQrCodes(buf: Buffer): string[] {
  const img = decodeToRgba(buf)
  if (!img) return []
  const found = new Set<string>()
  const attempts: Array<() => Rgba> = [
    () => img,
    () => downscale2x(img),
    () => centerCrop(img, 0.5),
    () => downscale2x(centerCrop(img, 0.6)),
  ]
  for (const make of attempts) {
    let hit: string | null = null
    try {
      hit = scan(make())
    } catch {
      hit = null
    }
    if (hit) {
      found.add(hit)
      break
    }
  }
  return Array.from(found)
}

// ---- vCard / MECARD ------------------------------------------------------

export interface CardFields {
  name: string | null
  phones: string[]
  emails: string[]
  org: string | null
  title: string | null
  urls: string[]
}

function unescapeVcard(v: string): string {
  return v.replace(/\\n/gi, " ").replace(/\\([,;:\\])/g, "$1").trim()
}

/** Minimal vCard 2.1/3.0/4.0 reader: FN/N, TEL, EMAIL, ORG, TITLE, URL. */
export function parseVCard(text: string): CardFields | null {
  if (!/BEGIN:VCARD/i.test(text)) return null
  // Unfold continuation lines (a line starting with a space/tab continues the previous one).
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n")
  const out: CardFields = { name: null, phones: [], emails: [], org: null, title: null, urls: [] }
  let nField: string | null = null
  for (const line of lines) {
    const idx = line.indexOf(":")
    if (idx < 0) continue
    const key = line.slice(0, idx).toUpperCase()
    const value = line.slice(idx + 1)
    const prop = key.split(";")[0].replace(/^ITEM\d+\./, "")
    if (prop === "FN" && value.trim()) out.name = unescapeVcard(value)
    else if (prop === "N" && value.trim()) {
      const [last, first, middle] = value.split(";").map(unescapeVcard)
      nField = [first, middle, last].filter(Boolean).join(" ") || null
    } else if (prop === "TEL" && value.trim()) out.phones.push(value.replace(/^tel:/i, "").trim())
    else if (prop === "EMAIL" && value.trim()) out.emails.push(value.replace(/^mailto:/i, "").trim().toLowerCase())
    else if (prop === "ORG" && value.trim()) out.org = value.split(";").map(unescapeVcard).filter(Boolean).join(", ") || null
    else if (prop === "TITLE" && value.trim()) out.title = unescapeVcard(value)
    else if (prop === "URL" && value.trim()) out.urls.push(value.trim())
  }
  if (!out.name) out.name = nField
  return out
}

/** MECARD:N:Doe,John;TEL:4085551212;EMAIL:j@x.com;ORG:Acme;; */
export function parseMeCard(text: string): CardFields | null {
  const t = text.trim()
  if (!/^MECARD:/i.test(t)) return null
  const body = t.slice(7)
  const out: CardFields = { name: null, phones: [], emails: [], org: null, title: null, urls: [] }
  // Split on unescaped ';'
  const parts: string[] = []
  let cur = ""
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "\\" && i + 1 < body.length) {
      cur += body[++i]
      continue
    }
    if (ch === ";") {
      parts.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur) parts.push(cur)
  for (const p of parts) {
    const idx = p.indexOf(":")
    if (idx < 0) continue
    const k = p.slice(0, idx).toUpperCase()
    const v = p.slice(idx + 1).trim()
    if (!v) continue
    if (k === "N") {
      const [last, first] = v.split(",").map((x) => x.trim())
      out.name = first ? `${first} ${last}`.trim() : last
    } else if (k === "TEL") out.phones.push(v)
    else if (k === "EMAIL") out.emails.push(v.toLowerCase())
    else if (k === "ORG") out.org = v
    else if (k === "TITLE") out.title = v
    else if (k === "URL") out.urls.push(v)
  }
  return out
}

// ---- Phones ----------------------------------------------------------------

/** A US number as exactly 10 digits, or null. Accepts +1 / 1 prefixes and any
 *  punctuation; rejects anything that isn't a plausible NANP number. */
export function normalizePhone10(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = String(raw).replace(/\D/g, "")
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1)
  if (d.length !== 10) return null
  if (d[0] === "0" || d[0] === "1") return null
  return d
}

/** Do these 10 digits appear in the text (ignoring punctuation)? Used to make
 *  sure a QR-sourced phone came from the fetched card, not the model. */
export function phoneAppearsIn(phone10: string, text: string): boolean {
  if (!/^\d{10}$/.test(phone10)) return false
  // Each run of digits-with-punctuation, collapsed to digits.
  const runs = text.match(/\+?\d[\d\s().\-‑–]{6,}\d/g) ?? []
  for (const r of runs) {
    const d = r.replace(/\D/g, "")
    if (d === phone10 || d === `1${phone10}`) return true
  }
  return text.replace(/\D/g, "").includes(phone10)
}

// ---- URL fetch ---------------------------------------------------------------

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const MAX_BYTES = 1024 * 1024
const MAX_TEXT = 8000

/** Refuse obvious internal targets — the QR is untrusted input. */
export function isFetchableUrl(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null
  const h = u.hostname.toLowerCase()
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return null
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number)
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null
  }
  if (h.startsWith("[")) return null
  return u
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
      if (total >= MAX_BYTES) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, MAX_BYTES).toString("utf8")
}

/** HTML → readable text: drop scripts/styles/tags, keep tel:/mailto: targets
 *  (digital-card pages often only carry the number inside the link). */
export function htmlToText(html: string): string {
  const links: string[] = []
  html.replace(/href\s*=\s*["']((?:tel|mailto):[^"']+)["']/gi, (_m, h: string) => {
    links.push(decodeURIComponent(h))
    return ""
  })
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim()
  const metas: string[] = []
  html.replace(/<meta[^>]+(?:property|name)\s*=\s*["'](og:title|og:description|description)["'][^>]*content\s*=\s*["']([^"']*)["']/gi, (_m, _k, v: string) => {
    metas.push(v)
    return ""
  })
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|tr|section|a|span)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
  const head = [title ? `Title: ${title}` : "", ...metas.map((m) => `Meta: ${m}`), ...links.map((l) => `Link: ${l}`)].filter(Boolean).join("\n")
  return `${head}${head ? "\n" : ""}${body}`.slice(0, MAX_TEXT)
}

/** First link to a .vcf file in the page, resolved against the page URL. */
export function findVcfLink(html: string, base: string): string | null {
  const m = /href\s*=\s*["']([^"']+?\.vcf(?:\?[^"']*)?)["']/i.exec(html) ?? /href\s*=\s*["']([^"']*(?:vcard|vcf)[^"']*)["']/i.exec(html)
  if (!m) return null
  try {
    return new URL(m[1].replace(/&amp;/g, "&"), base).toString()
  } catch {
    return null
  }
}

/** GET with redirects followed by hand (≤ 5 hops) so every hop is checked
 *  against isFetchableUrl. One 8 s budget for the whole chain. */
async function fetchOnce(url: string): Promise<{ res: Response; text: string; finalUrl: string }> {
  const signal = AbortSignal.timeout(8000)
  let current = url
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/vcard,text/x-vcard,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
      signal,
      cache: "no-store",
    })
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null
    if (loc) {
      const next = isFetchableUrl(new URL(loc, current).toString())
      if (!next) throw new Error("redirected to a blocked address")
      current = next.toString()
      continue
    }
    const text = await readCapped(res)
    return { res, text, finalUrl: current }
  }
  throw new Error("too many redirects")
}

function isVcardResponse(res: Response, text: string): boolean {
  return /vcard|x-vcard|directory/i.test(res.headers.get("content-type") ?? "") || /^\s*BEGIN:VCARD/i.test(text)
}

export interface QrFinding {
  payload: string
  kind: "vcard" | "mecard" | "url" | "text"
  /** parsed card fields when the payload (or a fetched .vcf) was a card */
  card: CardFields | null
  /** text read from the linked page / vCard, capped at ~8,000 chars */
  fetchedText: string | null
  finalUrl?: string
  /** a fetch / parse problem, for the summary — never fatal */
  error?: string
}

/** Turn one QR payload into something the planner can read. */
export async function resolveQrPayload(payload: string): Promise<QrFinding> {
  const p = payload.trim()
  if (/BEGIN:VCARD/i.test(p)) return { payload: p, kind: "vcard", card: parseVCard(p), fetchedText: null }
  if (/^MECARD:/i.test(p)) return { payload: p, kind: "mecard", card: parseMeCard(p), fetchedText: null }
  const isLink = /^https?:\/\//i.test(p)
  if (!isLink) return { payload: p, kind: "text", card: null, fetchedText: null }
  const url = isFetchableUrl(p)
  if (!url) return { payload: p, kind: "url", card: null, fetchedText: null, error: "link not fetchable" }
  try {
    const { res, text, finalUrl } = await fetchOnce(url.toString())
    if (!res.ok) return { payload: p, kind: "url", card: null, fetchedText: null, finalUrl, error: `link returned HTTP ${res.status}` }
    if (isVcardResponse(res, text)) {
      return { payload: p, kind: "url", card: parseVCard(text), fetchedText: text.slice(0, MAX_TEXT), finalUrl }
    }
    let pageText = htmlToText(text)
    let card: CardFields | null = null
    const vcf = findVcfLink(text, finalUrl)
    if (vcf && isFetchableUrl(vcf)) {
      try {
        const v = await fetchOnce(vcf)
        if (v.res.ok && isVcardResponse(v.res, v.text)) {
          card = parseVCard(v.text)
          pageText = `${pageText}\n\n--- vCard (${vcf}) ---\n${v.text}`.slice(0, MAX_TEXT + 4000)
        }
      } catch {
        /* the page text is still useful */
      }
    }
    return { payload: p, kind: "url", card, fetchedText: pageText, finalUrl }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : e.message) : String(e)
    return { payload: p, kind: "url", card: null, fetchedText: null, error: `couldn't open the link (${msg})` }
  }
}

/** Decode + resolve every QR in the photo. Never throws. */
export async function gatherQr(buf: Buffer): Promise<{ findings: QrFinding[]; notes: string[] }> {
  const notes: string[] = []
  let payloads: string[] = []
  try {
    payloads = decodeQrCodes(buf)
  } catch (e) {
    notes.push(`QR scan failed (${e instanceof Error ? e.message : String(e)})`)
  }
  const findings: QrFinding[] = []
  for (const p of payloads.slice(0, 3)) {
    try {
      const f = await resolveQrPayload(p)
      if (f.error) notes.push(`QR: ${f.error}`)
      findings.push(f)
    } catch (e) {
      notes.push(`QR: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { findings, notes }
}
