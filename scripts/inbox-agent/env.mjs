// Inbox Agent — shared env, Supabase, settings, time helpers.
// Runs on the Mac mini out of the main checkout (launchd sets WorkingDirectory),
// but resolves .env.local relative to this file so a worktree run also works,
// falling back to the main checkout's file (worktrees don't carry .env.local).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(__dirname, "../..")
export const MAIN_CHECKOUT = "/Users/ryanlarocca/Projects/PROJECTS/mission-control"

export function loadEnvLocal() {
  const candidates = [path.join(REPO_ROOT, ".env.local"), path.join(MAIN_CHECKOUT, ".env.local")]
  const envPath = candidates.find((p) => fs.existsSync(p))
  if (!envPath) return
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnvLocal()

export const MAILBOX = (process.env.INBOX_AGENT_MAILBOX || "ryan@lrghomes.com").toLowerCase()
export const DRIVE_ROOT_NAME = process.env.INBOX_DRIVE_ROOT_NAME || "Business Operations"
export const AUTO_THRESHOLD = Number(process.env.INBOX_AUTO_THRESHOLD || 5)
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_PDF_TO_MODEL_BYTES = 12 * 1024 * 1024

let _sb = null
export function sb() {
  if (_sb) return _sb
  const url = process.env.LRG_SUPABASE_URL
  const key = process.env.LRG_SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing")
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export function log(...args) {
  console.log(new Date().toISOString(), "[inbox-agent]", ...args)
}
export function warn(...args) {
  console.error(new Date().toISOString(), "[inbox-agent]", ...args)
}

export async function getSetting(key) {
  const { data, error } = await sb().from("inbox_settings").select("value").eq("key", key).maybeSingle()
  if (error) throw new Error(`inbox_settings read ${key}: ${error.message}`)
  return data?.value || {}
}
export async function setSetting(key, patch) {
  const current = await getSetting(key)
  const value = { ...current, ...patch }
  const { error } = await sb().from("inbox_settings").upsert({ key, value, updated_at: new Date().toISOString() })
  if (error) throw new Error(`inbox_settings write ${key}: ${error.message}`)
  return value
}

/** Page through a PostgREST query (1000-row cap). `build` receives a fresh
 *  query each page and must return it with filters applied (no range). */
export async function fetchAll(table, columns, build = (q) => q, order = "created_at") {
  const PAGE = 1000
  const out = []
  for (let from = 0; ; from += PAGE) {
    let q = sb().from(table).select(columns).order(order, { ascending: true }).range(from, from + PAGE - 1)
    q = build(q)
    const { data, error } = await q
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return out
}

// ---- Pacific-time helpers (the digest fires on Ryan's clock) ----
export function ptParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  })
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: p.weekday }
}
export function ptDateLabel(iso) {
  if (!iso) return "?"
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" }).format(new Date(iso))
}
export function daysAgo(iso) {
  if (!iso) return 0
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

/** "93 Ridgeview Ave, San Jose" → "93ridgeview"; "Halleck" → "halleck". */
export function propertyKey(label) {
  if (!label) return null
  const SUFFIX = new Set(["ave", "avenue", "dr", "drive", "st", "street", "rd", "road", "ct", "court", "ln", "lane", "blvd", "boulevard", "way", "pl", "place", "cir", "circle", "ter", "terrace", "hwy", "highway"])
  const tokens = label.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)
  const out = []
  for (const t of tokens) {
    if (SUFFIX.has(t)) break
    out.push(t)
    if (out.length >= 3) break
  }
  // number + up to two name words; if no leading number, first two words
  const key = out.join("")
  return key || null
}
export function keysMatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const na = a.replace(/^\d+/, "")
  const nb = b.replace(/^\d+/, "")
  if (!na || !nb) return false
  return na === nb || (na.length >= 5 && (a.includes(nb) || b.includes(na)))
}

export function sanitizeFilename(name) {
  return String(name || "file").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 180)
}
