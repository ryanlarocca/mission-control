#!/usr/bin/env node
// Project memos → Supabase project_memos (Mission Control 2.0, Part D,
// 2026-11-10). Feeds the /projects page and the Projects card on Today, so
// the page no longer reads folders live through the mini's tunnel.
//
// Walks ~/Projects/PROJECTS/*/PROJECT_MEMO.md and
// ~/Projects/PROJECTS/_archive/*/PROJECT_MEMO.md (folders with no memo,
// mission-control itself and _tmp* are skipped), parses each with
// lib/projectMemo.ts, upserts every row by slug and deletes rows whose memo
// is gone. Anything under _archive/ is retired + archived.
//
// A failure exits 1 and sends one Telegram line — a silent failure would leave
// the Projects page quietly stale (the page also flags data older than 36 h).
//
//   node scripts/projects-sync.mjs                       # what the schedule runs
//   node scripts/projects-sync.mjs --dry-run             # print what it would write; no database
//   node scripts/projects-sync.mjs --dry-run --json out.json   # also write the rows as JSON
//   node scripts/projects-sync.mjs --root <dir>          # another PROJECTS folder (tests)
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"
import { parseMemo } from "../lib/projectMemo.ts"

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
const DRY = has("--dry-run") || has("--dry")
const ROOT = path.resolve(flag("--root") || path.join(homedir(), "Projects", "PROJECTS"))
const JSON_OUT = flag("--json")

function loadEnv() {
  const file = new URL("../.env.local", import.meta.url)
  if (!existsSync(file)) return
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2")
  }
}

function skipFolder(name) {
  return name === "mission-control" || name === "_archive" || name.startsWith("_tmp") || name.startsWith(".")
}

function readIf(file) {
  try { return readFileSync(file, "utf8") } catch { return null }
}

/** Every memo under ROOT (top level first, then _archive/) → rows + warnings. */
export function collect(root = ROOT) {
  const rows = []
  const warnings = []
  const bySlug = new Map()
  const walk = (dir, archived) => {
    if (!existsSync(dir)) return
    const names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !skipFolder(d.name)).map((d) => d.name).sort()
    for (const slug of names) {
      const memo = readIf(path.join(dir, slug, "PROJECT_MEMO.md"))
      if (memo == null) continue
      if (bySlug.has(slug)) {
        warnings.push(`${slug}: memo in both PROJECTS/ and _archive/ — using the one in PROJECTS/`)
        continue
      }
      const { row, warnings: w } = parseMemo(memo, { slug, archived, changelog: readIf(path.join(dir, slug, "CHANGELOG.md")) })
      bySlug.set(slug, row)
      rows.push(row)
      warnings.push(...w.map((x) => (archived ? `_archive/${x}` : x)))
    }
  }
  walk(root, false)
  walk(path.join(root, "_archive"), true)
  return { rows, warnings }
}

// ── output ──────────────────────────────────────────────────────────────────
function table(rows) {
  const cols = [
    ["slug", (r) => (r.archived ? `_archive/${r.slug}` : r.slug)],
    ["name", (r) => r.name],
    ["status", (r) => r.status],
    ["updated", (r) => r.updated_on || "—"],
    ["plain", (r) => (r.plain ? "yes" : "no")],
    ["ships", (r) => String(r.ships.length)],
    ["left off", (r) => (r.left_off ? `${r.left_off.length} ch` : "—")],
  ]
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  const cells = rows.map((r) => cols.map(([, f]) => cut(String(f(r)), 44)))
  const widths = cols.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
  const fmt = (c) => c.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd()
  return [fmt(cols.map(([h]) => h)), fmt(widths.map((w) => "-".repeat(w))), ...cells.map(fmt)].join("\n")
}

// ── IO ──────────────────────────────────────────────────────────────────────
function db() {
  const url = process.env.LRG_SUPABASE_URL
  const key = process.env.LRG_SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY not set")
  return createClient(url, key, { auth: { persistSession: false } })
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

async function telegram(text) {
  if (DRY) { console.log(`--- (dry) Telegram ---\n${text}\n---`); return }
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) throw new Error("Telegram not configured")
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
  })
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`)
}

async function write(rows) {
  // An empty walk (wrong folder, unmounted disk) must not wipe the table.
  if (!rows.length) throw new Error(`found no project memos under ${ROOT}`)
  const sb = db()
  const syncedAt = new Date().toISOString()
  const { error: upErr } = await sb
    .from("project_memos")
    .upsert(rows.map((r) => ({ ...r, synced_at: syncedAt })), { onConflict: "slug" })
  if (upErr) throw new Error(`upsert: ${upErr.message}`)

  const { data: existing, error: selErr } = await sb.from("project_memos").select("slug").limit(5000)
  if (selErr) throw new Error(`list: ${selErr.message}`)
  const keep = new Set(rows.map((r) => r.slug))
  const gone = (existing || []).map((r) => r.slug).filter((s) => !keep.has(s))
  if (gone.length) {
    const { error: delErr } = await sb.from("project_memos").delete().in("slug", gone)
    if (delErr) throw new Error(`delete: ${delErr.message}`)
  }
  return { upserted: rows.length, deleted: gone }
}

async function main() {
  const { rows, warnings } = collect()
  if (DRY) {
    console.log(`[projects-sync] ${ROOT} — ${rows.length} memo${rows.length === 1 ? "" : "s"} (dry run, nothing written)\n`)
    console.log(table(rows))
    const counts = ["active", "planning", "parked", "retired"].map((s) => `${rows.filter((r) => r.status === s).length} ${s}`).join(" · ")
    console.log(`\n${counts}`)
    if (warnings.length) console.log(`\nwarnings:\n${warnings.map((w) => `  ! ${w}`).join("\n")}`)
    if (JSON_OUT) {
      const syncedAt = new Date().toISOString()
      writeFileSync(JSON_OUT, JSON.stringify(rows.map((r) => ({ ...r, synced_at: syncedAt })), null, 2))
      console.log(`\nrows written to ${JSON_OUT}`)
    }
    return
  }
  for (const w of warnings) console.warn(`[projects-sync] ! ${w}`)
  const { upserted, deleted } = await write(rows)
  console.log(`[projects-sync] upserted ${upserted}${deleted.length ? `, removed ${deleted.join(", ")}` : ""}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv()
  main().catch(async (e) => {
    console.error("[projects-sync] failed:", e)
    try { await telegram(`🔴 <b>Projects sync failed</b> — the Projects page is going stale: ${esc(String(e.message || e).slice(0, 200))}`) } catch (te) { console.error("[projects-sync] Telegram failed too:", te.message) }
    process.exit(1)
  })
}
