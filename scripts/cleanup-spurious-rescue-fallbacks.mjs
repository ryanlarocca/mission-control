#!/usr/bin/env node
// One-off cleanup for spurious fallback voicemail rows created by the
// earlier (buggy) rescue runs. The voice/recording webhook's lookup
// window was 60 minutes from NOW, so when the rescue script POSTed for
// an orphan older than 60 min the webhook didn't find the original row
// and ran its "fallback insert" path — creating a fresh voicemail row
// with the rescued recording attached, while the original orphan row
// stayed empty.
//
// This script:
//   1. Lists every orphan row created BEFORE today that still has
//      recording_url IS NULL (those are the ones the bad rescue missed).
//   2. For each, finds a fallback voicemail row created in the last hour
//      with matching caller_phone + non-null recording_url + status=new.
//   3. Prints them. With --execute, deletes the fallback rows.
//
// Usage:
//   node scripts/cleanup-spurious-rescue-fallbacks.mjs              # dry-run
//   node scripts/cleanup-spurious-rescue-fallbacks.mjs --execute    # delete

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

const execute = process.argv.includes("--execute")
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)

// Look-back for orphans we tried to rescue: anything in the last 4 days
// that still has recording_url IS NULL.
const orphanSince = new Date(Date.now() - 4 * 86_400_000).toISOString()
const { data: orphans, error: e1 } = await sb
  .from("leads")
  .select("id, caller_phone, twilio_number, lead_type, created_at, name")
  .is("recording_url", null)
  .in("lead_type", ["call", "voicemail"])
  .gte("created_at", orphanSince)
  .order("created_at", { ascending: false })
if (e1) { console.error("orphan lookup failed:", e1.message); process.exit(1) }
console.log(`Found ${orphans.length} still-orphaned call/voicemail row(s).`)

// Fallback rows must have been created during my testing window
// (roughly the last 2 hours). They're voicemail rows with a recording_url
// set and status=new. Find candidates.
const fallbackSince = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
const { data: fallbacks, error: e2 } = await sb
  .from("leads")
  .select("id, caller_phone, twilio_number, lead_type, status, recording_url, created_at, message")
  .gte("created_at", fallbackSince)
  .eq("lead_type", "voicemail")
  .eq("status", "new")
  .not("recording_url", "is", null)
if (e2) { console.error("fallback lookup failed:", e2.message); process.exit(1) }
console.log(`Found ${fallbacks.length} recent voicemail row(s) with recording_url set + status=new (fallback candidates).\n`)

const toDelete = []
for (const o of orphans) {
  if (!o.caller_phone) continue
  // A fallback row for this orphan: same caller_phone, created AFTER the
  // orphan, status=new, has recording_url. Pick the most recent.
  const matches = fallbacks
    .filter(f => f.caller_phone === o.caller_phone && new Date(f.created_at) > new Date(o.created_at))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  if (matches.length === 0) continue
  const f = matches[0]
  console.log(`ORPHAN  ${o.created_at}  ${o.lead_type.padEnd(10)} ${(o.name||"(no name)").padEnd(15)} ${o.caller_phone}  id=${o.id}`)
  console.log(`  → FALLBACK to delete:  ${f.created_at}  voicemail  rec=${f.recording_url.slice(-40)}  id=${f.id}`)
  toDelete.push({ orphan: o, fallback: f })
}

console.log(`\nTotal: ${toDelete.length} fallback row(s) to delete.`)

if (!execute) {
  console.log("Dry-run — re-run with --execute to delete.")
  process.exit(0)
}

let deleted = 0
for (const item of toDelete) {
  const { error } = await sb.from("leads").delete().eq("id", item.fallback.id)
  if (error) console.error(`  ✗ delete ${item.fallback.id}: ${error.message}`)
  else { console.log(`  ✓ deleted ${item.fallback.id}`); deleted++ }
}
console.log(`\nDeleted ${deleted}/${toDelete.length} fallback row(s).`)
