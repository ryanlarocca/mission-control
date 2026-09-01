#!/usr/bin/env node
// Tag the approved call-block clusters (Ryan, 2026-09-01) so they're searchable
// in the Leads tab via "#callblock" (search matches notes — LeadsTab.tsx:585),
// and revive the 3 clusters Ryan confirmed were wrongly marked dead.
//
// Sources (built + audited in PROJECTS/lead-skip-trace/data/call-block-2026-08-31):
//   call_block_final.csv   — tier-1: never connected (41)
//   tier2_went_cold.csv    — tier-2: connected once, then went cold (20)
//   + 3 revived clusters   — hardcoded below, Ryan-approved 2026-09-01
//
// Rules: DNC/junk flags are NEVER touched. Ryan-typed notes are never
// overwritten — the tag is one appended line; any prior "#callblock" line is
// replaced (idempotent re-runs). Revive = status dead→contacted, only on the
// 3 approved phones.
//
// Usage: node scripts/tag-call-block.mjs [--revive] [--tag] [--dry-run]
import fs from "node:fs"
import path from "node:path"

const envPath = [
  path.join(process.cwd(), ".env.local"),
  "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local",
].find((p) => fs.existsSync(p))
const env = {}
for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "")
}
const SB = env.LRG_SUPABASE_URL
const H = { apikey: env.LRG_SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.LRG_SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" }

const DIR = "/Users/ryanlarocca/Projects/PROJECTS/lead-skip-trace/data/call-block-2026-08-31"
const DRY = process.argv.includes("--dry-run")
const DO_REVIVE = process.argv.includes("--revive")
const DO_TAG = process.argv.includes("--tag")
if (!DO_REVIVE && !DO_TAG) { console.error("usage: tag-call-block.mjs [--revive] [--tag] [--dry-run]"); process.exit(1) }
const TODAY = new Date().toLocaleDateString("en-CA")

// Ryan-approved revives (audit 2026-09-01). DNC/junk untouched by design.
const REVIVE = [
  { phone: "+14155064782", who: "Jack Tertorici — 7-unit Belmont, $2.995M asking in VM, never called back" },
  { phone: "+14084720932", who: "engaged 1031 VM (Montgomery/Los Gatos, ~$8.5M), never called back" },
  { phone: "+14082214111", who: "Cinepol Subramanian — mutual phone tag through 8/27, wrongly dead" },
]

function parseCsv(file) {
  const lines = fs.readFileSync(path.join(DIR, file), "utf-8").trim().split("\n").slice(1)
  return lines.map((l) => {
    const out = []; let cur = "", q = false
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = "" } else cur += ch }
    out.push(cur); return out
  })
}
const e164 = (p) => "+1" + p.replace(/\D/g, "").slice(-10)
const trim = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n)

async function sb(pathq, opts) {
  const r = await fetch(`${SB}/rest/v1/${pathq}`, { headers: H, ...opts })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.headers.get("content-type")?.includes("json") ? r.json() : null
}

if (DO_REVIVE) {
  for (const { phone, who } of REVIVE) {
    if (DRY) { console.log(`[dry] revive ${phone} — ${who}`); continue }
    const rows = await sb(`leads?caller_phone=eq.${encodeURIComponent(phone)}&status=eq.dead&select=id`, {
      method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ status: "contacted" }),
    })
    console.log(`revived ${rows.length} row(s): ${phone} — ${who}`)
  }
}

if (DO_TAG) {
  const tier1 = parseCsv("call_block_final.csv").map((r) => ({
    phone: e164(r[0]),
    line: `#callblock T1 never-connected (${r[4]})${r[5] ? ` — ${trim(r[5], 60)}` : ""} — ${trim(r[12], 120)} [${TODAY}]`,
  }))
  const tier2 = parseCsv("tier2_went_cold.csv").map((r) => ({
    phone: e164(r[0]),
    line: `#callblock T2 went-cold-after-contact — ${trim(r[4], 140)} [${TODAY}]`,
  }))
  const revived = REVIVE.map((r) => ({ phone: r.phone, line: `#callblock T1 never-connected (revived from dead ${TODAY}) — ${trim(r.who, 120)} [${TODAY}]` }))
  // tier-1 wins on overlap; revived only if not already present
  const byPhone = new Map()
  for (const t of [...tier2, ...revived, ...tier1]) byPhone.set(t.phone, t)
  console.log(`${byPhone.size} clusters to tag${DRY ? " (dry run)" : ""}`)

  let tagged = 0
  for (const { phone, line } of byPhone.values()) {
    const rows = await sb(`leads?caller_phone=eq.${encodeURIComponent(phone)}&select=id,notes`)
    if (!rows.length) { console.log(`  ✗ no rows for ${phone}`); continue }
    for (const r of rows) {
      const prior = (r.notes || "").split("\n").filter((l) => !l.startsWith("#callblock")).join("\n").trim()
      const notes = prior ? `${prior}\n${line}` : line
      if (DRY) continue
      await sb(`leads?id=eq.${r.id}`, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify({ notes }) })
    }
    tagged++
    if (DRY) console.log(`  [dry] ${phone}: ${line.slice(0, 100)}`)
  }
  console.log(`${DRY ? "would tag" : "tagged"} ${tagged} clusters`)
}
