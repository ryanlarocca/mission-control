#!/usr/bin/env node
// One-shot backfill: dedupe cluster-stamp duplicates that accumulated before
// the apply-drip + long-term-nurture endpoints learned to sweep siblings,
// AND before the engine's fetchEligibleLeads gained cluster dedupe.
//
// Problem (Brian Bernasconi 2026-05-17): when multiple leads-table rows in
// the same cluster (same phone / email / gmail_thread) carry
// drip_campaign_type, the drip engine treats each row as a separate driver
// and queues N parallel touches. Result: Ryan sees the same lead 3-5 times
// in the Drips tab and has to snooze each one.
//
// This script walks every cluster, picks the canonical "active driver" row
// (engine-touched > highest touch_number > most-recent last_drip_sent_at >
// most-recent created_at), and un-stamps every OTHER stamped row in the
// cluster. The losers' drip_campaign_type / drip_touch_number /
// last_drip_sent_at all go to null; nothing else on the row is touched.
//
// Also: any pending/approved drip_queue rows pointing at a loser get
// flipped to status="skipped" with error="cluster_dedupe_2026-05-17" so
// they fall out of the Drips tab immediately.
//
// Usage:
//   node scripts/backfill-dedupe-cluster-stamps-2026-05-17.mjs --dry-run
//   node scripts/backfill-dedupe-cluster-stamps-2026-05-17.mjs            # apply

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

const DRY = process.argv.includes("--dry-run")
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)

function clusterKey(lead) {
  if (lead.caller_phone && lead.caller_phone !== "Anonymous") return `phone:${lead.caller_phone}`
  if (lead.gmail_thread_id) return `thread:${lead.gmail_thread_id}`
  if (lead.email) return `email:${(lead.email || "").toLowerCase()}`
  return `id:${lead.id}`
}

const { data: stamped, error } = await sb.from("leads")
  .select("id, name, caller_phone, email, gmail_thread_id, drip_campaign_type, drip_touch_number, last_drip_sent_at, created_at")
  .not("drip_campaign_type", "is", null)
  .order("created_at", { ascending: false })
if (error) { console.error(error); process.exit(1) }
console.log(`Stamped rows: ${stamped.length}`)

const clusters = new Map()
for (const r of stamped) {
  const k = clusterKey(r)
  if (!clusters.has(k)) clusters.set(k, [])
  clusters.get(k).push(r)
}

// Mirrors lib/leads.ts pickClusterWinner — two-stage pick.
function pickWinner(rows) {
  if (rows.length === 1) return rows[0]
  const byCampaign = new Map()
  for (const r of rows) {
    const k = r.drip_campaign_type || "__null__"
    if (!byCampaign.has(k)) byCampaign.set(k, [])
    byCampaign.get(k).push(r)
  }
  let winningCampaign = null, bestTs = -Infinity
  byCampaign.forEach((crows, campaign) => {
    const maxTs = Math.max(...crows.map(r =>
      r.last_drip_sent_at ? new Date(r.last_drip_sent_at).getTime() : new Date(r.created_at).getTime()
    ))
    if (maxTs > bestTs) { bestTs = maxTs; winningCampaign = campaign }
  })
  return byCampaign.get(winningCampaign).slice().sort((a, b) => {
    const aT = a.last_drip_sent_at != null
    const bT = b.last_drip_sent_at != null
    if (aT !== bT) return bT ? 1 : -1
    const aN = a.drip_touch_number ?? 0
    const bN = b.drip_touch_number ?? 0
    if (aN !== bN) return bN - aN
    const aL = a.last_drip_sent_at ? new Date(a.last_drip_sent_at).getTime() : 0
    const bL = b.last_drip_sent_at ? new Date(b.last_drip_sent_at).getTime() : 0
    if (aL !== bL) return bL - aL
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })[0]
}

const losers = []
for (const [key, rows] of clusters) {
  if (rows.length <= 1) continue
  const winner = pickWinner(rows)
  // Order display: winner first, then losers
  const ordered = [winner, ...rows.filter(r => r.id !== winner.id)]
  rows.length = 0; rows.push(...ordered)
  const name = rows.find(r => r.name)?.name || "(no name)"
  console.log(`\n${name} (${key})`)
  console.log(`  KEEP   ${winner.id.slice(0,8)} ${winner.drip_campaign_type} touch=${winner.drip_touch_number ?? "—"} last=${winner.last_drip_sent_at?.slice(0,16) || "—"}`)
  for (const loser of rows.slice(1)) {
    console.log(`  UNSTAMP ${loser.id.slice(0,8)} ${loser.drip_campaign_type} touch=${loser.drip_touch_number ?? "—"} last=${loser.last_drip_sent_at?.slice(0,16) || "—"}`)
    losers.push(loser.id)
  }
}

console.log(`\nTotal clusters with duplicates: ${[...clusters.values()].filter(r => r.length > 1).length}`)
console.log(`Total rows to un-stamp: ${losers.length}`)

if (DRY) { console.log("\nDry run — no writes."); process.exit(0) }
if (losers.length === 0) { console.log("\nNothing to do."); process.exit(0) }

// 1) Un-stamp loser rows
const { error: unstampErr } = await sb.from("leads")
  .update({ drip_campaign_type: null, drip_touch_number: null, last_drip_sent_at: null })
  .in("id", losers)
if (unstampErr) { console.error("Un-stamp failed:", unstampErr); process.exit(1) }
console.log(`\n✓ Un-stamped ${losers.length} rows`)

// 2) Skip any in-flight drip_queue rows attached to a loser
const { data: skippedRows, error: skipErr } = await sb.from("drip_queue")
  .update({ status: "skipped", error: "cluster_dedupe_2026-05-17" })
  .in("lead_id", losers)
  .in("status", ["pending", "approved"])
  .select("id")
if (skipErr) console.warn("drip_queue sweep error:", skipErr.message)
else console.log(`✓ Skipped ${(skippedRows ?? []).length} pending/approved drip_queue rows tied to loser rows`)

console.log("\nDone.")
