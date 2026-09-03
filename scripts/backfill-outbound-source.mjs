#!/usr/bin/env node
// Outbound rows written with source=null, orphaned from their cluster's campaign.
//
// Both Telegram reply paths called sendLeadSms({ source: null }) outright and
// the UI send route defaults to null when the client omits it, so a reply Ryan
// fired from his phone landed with no campaign attribution while the inbound it
// answered carried one (2026-09-03: "Sure" to +16504643993, source=null, in a
// cluster whose inbound was source="Outbound"). sendLeadSms now inherits the
// cluster source at write time; this fills in the rows already written.
//
// Only touches rows where source IS NULL and the cluster has exactly one
// distinct non-null source — an ambiguous cluster is left alone rather than
// guessed at.
//
//   node scripts/backfill-outbound-source.mjs            # dry run
//   node scripts/backfill-outbound-source.mjs --write
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
const H = {
  apikey: env.LRG_SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.LRG_SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
}
const WRITE = process.argv.includes("--write")

let rows = []
for (let o = 0; ; o += 1000) {
  const r = await fetch(`${SB}/rest/v1/leads?select=id,created_at,caller_phone,lead_type,twilio_number,source,message&order=created_at.asc`, { headers: { ...H, Range: `${o}-${o + 999}` } })
  const j = await r.json()
  rows.push(...j)
  if (j.length < 1000) break
}

const byPhone = new Map()
for (const r of rows) {
  if (!r.caller_phone) continue
  if (!byPhone.has(r.caller_phone)) byPhone.set(r.caller_phone, [])
  byPhone.get(r.caller_phone).push(r)
}

const fixes = []
let ambiguous = 0
for (const [phone, rs] of byPhone) {
  const orphans = rs.filter((r) => !r.twilio_number && !r.source)
  if (!orphans.length) continue
  const sources = [...new Set(rs.map((r) => r.source).filter(Boolean))]
  if (sources.length !== 1) { ambiguous += orphans.length; continue }
  for (const o of orphans) fixes.push({ ...o, inherit: sources[0] })
}

console.log(`${rows.length} lead rows`)
console.log(`orphaned outbound rows fixable: ${fixes.length}   left alone (cluster has 0 or >1 source): ${ambiguous}`)
console.log(`${WRITE ? "WRITING" : "DRY RUN — pass --write to apply"}\n`)

const bySrc = {}
for (const f of fixes) bySrc[f.inherit] = (bySrc[f.inherit] || 0) + 1
console.log("by inherited source:", JSON.stringify(bySrc), "\n")
for (const f of fixes.slice(0, 12)) {
  console.log(`  ${f.created_at.slice(0, 16)} ${f.caller_phone} ${String(f.lead_type).padEnd(6)} → ${f.inherit}   "${(f.message || "").replace(/\s+/g, " ").slice(0, 44)}"`)
}
if (fixes.length > 12) console.log(`  …+${fixes.length - 12} more`)

if (!WRITE) process.exit(0)
let n = 0
for (const f of fixes) {
  const res = await fetch(`${SB}/rest/v1/leads?id=eq.${f.id}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ source: f.inherit }),
  })
  if (res.ok) n++
  else console.log(`  ✗ ${f.id.slice(0, 8)} ${res.status} ${await res.text()}`)
}
console.log(`\ndone: ${n} row(s) attributed`)
