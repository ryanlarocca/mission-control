#!/usr/bin/env node
// One-shot cleanup for the touch-#0 perpetual-loop bug (2026-05-11).
//
// Symptom: pre-fix, the engine re-queued touch #0 every hour for any
// direct_mail_call lead at drip_touch_number=0 with no recording_url.
// Some leads accumulated multiple pending drip_queue rows for touch #0.
//
// This script finds those duplicates and deletes all but the most recent
// pending row per (lead_id, touch_number=0) cluster. DRY_RUN=1 to preview.

import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"

// Minimal .env.local loader (no dotenv dep).
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "")
}

const DRY = process.env.DRY_RUN === "1"
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)

const { data: rows, error } = await sb
  .from("drip_queue")
  .select("id, lead_id, touch_number, status, created_at")
  .eq("status", "pending")
  .eq("touch_number", 0)
  .order("created_at", { ascending: false })

if (error) {
  console.error("query failed:", error.message)
  process.exit(1)
}

console.log(`[cleanup] ${rows.length} pending touch_number=0 rows total`)

const byLead = new Map()
for (const r of rows) {
  if (!byLead.has(r.lead_id)) byLead.set(r.lead_id, [])
  byLead.get(r.lead_id).push(r)
}

const dupes = []
for (const [leadId, group] of byLead) {
  if (group.length <= 1) continue
  // keep most-recent (group is already DESC on created_at), delete the rest
  const [keep, ...drop] = group
  console.log(`[cleanup] lead ${leadId}: ${group.length} dupes, keeping ${keep.id} (${keep.created_at}), dropping ${drop.length}`)
  dupes.push(...drop.map(r => r.id))
}

console.log(`[cleanup] ${dupes.length} duplicate rows to delete`)

if (dupes.length === 0) {
  console.log("[cleanup] nothing to do")
  process.exit(0)
}

if (DRY) {
  console.log("[cleanup] DRY_RUN=1 — no deletes")
  process.exit(0)
}

const { error: delErr } = await sb.from("drip_queue").delete().in("id", dupes)
if (delErr) {
  console.error("delete failed:", delErr.message)
  process.exit(1)
}
console.log(`[cleanup] deleted ${dupes.length} duplicate rows`)
