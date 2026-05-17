#!/usr/bin/env node
// One-shot triage for mis-tagged Google Ads leads (2026-05-11).
//
// Symptom: leads with source='Google Ads' had drip_campaign_type incorrectly
// stamped 'direct_mail_call' by the (pre-fix) Apply Drip route, which routed
// any phone-bearing lead to direct_mail_call regardless of source. The engine
// then queued touch #0 "I missed your call" copy that doesn't fit a form lead.
//
// This script:
//   1. Finds Google Ads leads currently tagged direct_mail_call.
//   2. Clears drip_campaign_type/drip_touch_number/last_drip_sent_at so the
//      next Apply Drip click (post-fix) routes them correctly.
//   3. Skips any pending drip_queue rows attached to those leads so the wrong
//      message can't fire.
//
// DRY_RUN=1 to preview.

import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "")
}

const DRY = process.env.DRY_RUN === "1"
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)

// 1. Find mis-tagged leads.
const { data: mistagged, error } = await sb
  .from("leads")
  .select("id, name, caller_phone, source, lead_type, drip_campaign_type, drip_touch_number, last_drip_sent_at, created_at")
  .eq("source", "Google Ads")
  .eq("drip_campaign_type", "direct_mail_call")
  .order("created_at", { ascending: false })

if (error) {
  console.error("[triage] query failed:", error.message)
  process.exit(1)
}

console.log(`[triage] found ${mistagged.length} Google Ads lead(s) tagged direct_mail_call`)
for (const r of mistagged) {
  console.log(`  - ${r.id} | ${r.caller_phone || "<no phone>"} | ${r.lead_type} | touch=${r.drip_touch_number} | created ${r.created_at}`)
}

if (mistagged.length === 0) {
  console.log("[triage] nothing to repair")
  process.exit(0)
}

// 2. Find pending drip_queue rows attached to these leads.
const leadIds = mistagged.map(r => r.id)
const { data: pendingQueue } = await sb
  .from("drip_queue")
  .select("id, lead_id, touch_number, status, created_at, message")
  .in("lead_id", leadIds)
  .eq("status", "pending")

console.log(`\n[triage] ${pendingQueue.length} pending drip_queue row(s) on these leads will be skipped`)
for (const q of pendingQueue) {
  console.log(`  - queue ${q.id} | lead ${q.lead_id} | touch #${q.touch_number} | "${(q.message || "").slice(0, 60)}..."`)
}

if (DRY) {
  console.log("\n[triage] DRY_RUN=1 — no writes")
  process.exit(0)
}

// 3. Skip pending queue rows.
if (pendingQueue.length > 0) {
  const { error: skipErr } = await sb
    .from("drip_queue")
    .update({ status: "skipped" })
    .in("id", pendingQueue.map(q => q.id))
  if (skipErr) {
    console.error("[triage] skip pending queue failed:", skipErr.message)
    process.exit(1)
  }
  console.log(`[triage] skipped ${pendingQueue.length} pending queue row(s)`)
}

// 4. Clear drip tags on mis-tagged leads.
const { error: clearErr } = await sb
  .from("leads")
  .update({
    drip_campaign_type: null,
    drip_touch_number: null,
    last_drip_sent_at: null,
  })
  .in("id", leadIds)
if (clearErr) {
  console.error("[triage] clear drip tags failed:", clearErr.message)
  process.exit(1)
}
console.log(`[triage] cleared drip tags on ${leadIds.length} lead(s)`)
console.log("[triage] done. Re-Apply Drip from MC to re-enroll under the correct campaign.")
