#!/usr/bin/env node
// Find leads where Ryan (or the AI summary) indicates a commitment to send an
// offer / estimate / quote / price. Scans ai_summary, ai_notes, notes,
// followup_reason, suggested_reply across every leads row, then groups by
// cluster (phone → gmail_thread_id → email → id) and prints one card per
// cluster sorted by most-recent activity.
//
// Usage:
//   node scripts/find-offer-leads.mjs              # default keywords
//   node scripts/find-offer-leads.mjs offer quote  # custom keywords

import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) {
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)

const customKeywords = process.argv.slice(2).filter(a => !a.startsWith("--"))
const KEYWORDS = customKeywords.length > 0 ? customKeywords : ["offer", "estimate", "quote"]
const TEXT_FIELDS = ["ai_summary", "ai_notes", "notes", "followup_reason", "suggested_reply"]

const orParts = []
for (const kw of KEYWORDS) {
  for (const f of TEXT_FIELDS) orParts.push(`${f}.ilike.%${kw}%`)
}

const { data: hits, error } = await sb
  .from("leads")
  .select("id, caller_phone, email, gmail_thread_id, name, property_address, status, temperature, is_dnc, is_junk, source, source_type, lead_type, ai_summary, ai_notes, notes, followup_reason, recommended_followup_date, suggested_reply, created_at")
  .or(orParts.join(","))
  .order("created_at", { ascending: false })

if (error) { console.error("query failed:", error.message); process.exit(1) }
if (!hits || hits.length === 0) {
  console.log(`No leads matched keywords: ${KEYWORDS.join(", ")}`)
  process.exit(0)
}

// Cluster by phone → gmail_thread → email → id, mirroring groupLeads logic.
const clusters = new Map()
for (const r of hits) {
  const key =
    r.caller_phone ? `phone:${r.caller_phone}` :
    r.gmail_thread_id ? `thread:${r.gmail_thread_id}` :
    r.email ? `email:${r.email.toLowerCase()}` :
    `id:${r.id}`
  if (!clusters.has(key)) clusters.set(key, [])
  clusters.get(key).push(r)
}

// Find which fields/keywords matched for a given row.
function matchesFor(row) {
  const out = []
  for (const f of TEXT_FIELDS) {
    const v = row[f]
    if (!v) continue
    const matched = KEYWORDS.filter(kw => v.toLowerCase().includes(kw.toLowerCase()))
    if (matched.length) out.push({ field: f, keywords: matched, snippet: snippet(v, matched[0]) })
  }
  return out
}

function snippet(text, kw, radius = 50) {
  const i = text.toLowerCase().indexOf(kw.toLowerCase())
  if (i < 0) return text.slice(0, 100)
  const start = Math.max(0, i - radius)
  const end = Math.min(text.length, i + kw.length + radius)
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "")
}

function fmtDate(iso) {
  if (!iso) return "—"
  const d = new Date(iso)
  return d.toISOString().slice(0, 10)
}

const sortedClusters = [...clusters.entries()].sort(([, a], [, b]) => {
  const aMax = Math.max(...a.map(r => new Date(r.created_at).getTime()))
  const bMax = Math.max(...b.map(r => new Date(r.created_at).getTime()))
  return bMax - aMax
})

console.log(`\n${sortedClusters.length} cluster(s) match keywords: ${KEYWORDS.join(", ")}`)
console.log("─".repeat(78))

for (const [key, rows] of sortedClusters) {
  const newest = rows[0]
  const allRows = rows.length
  const name = newest.name || "(no name)"
  const contact = newest.caller_phone || newest.email || "—"
  const flags = []
  if (newest.is_dnc) flags.push("DNC")
  if (newest.is_junk) flags.push("JUNK")
  const status = newest.status || "—"
  const temp = newest.temperature ? ` ${newest.temperature}` : ""
  const flagStr = flags.length ? ` [${flags.join(",")}]` : ""

  console.log(`\n${name}  (${contact})`)
  console.log(`  status: ${status}${temp}${flagStr}  source: ${newest.source || "—"}  rows: ${allRows}  newest: ${fmtDate(newest.created_at)}`)
  if (newest.property_address) console.log(`  property: ${newest.property_address}`)
  if (newest.recommended_followup_date) {
    console.log(`  follow-up: ${newest.recommended_followup_date}  reason: ${(newest.followup_reason || "—").slice(0, 80)}`)
  }

  // Show matches across all rows in the cluster, deduped by (field, snippet).
  const seen = new Set()
  for (const r of rows) {
    for (const m of matchesFor(r)) {
      const k = `${m.field}|${m.snippet}`
      if (seen.has(k)) continue
      seen.add(k)
      console.log(`  · [${m.field}] (${m.keywords.join(",")}) ${m.snippet}`)
    }
  }
  console.log(`  inspect: node scripts/inspect-lead.mjs ${newest.caller_phone || newest.email || newest.id}`)
}

console.log("\n" + "─".repeat(78))
console.log(`Total: ${sortedClusters.length} cluster(s), ${hits.length} matching row(s).`)
