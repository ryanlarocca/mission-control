#!/usr/bin/env node
// End-to-end test of the Drips tab API surface against the dev server.
// Covers: GET /api/drips (5 buckets, dedupe + Anonymous filter, due_now
// flag), PATCH edit, POST /api/drips/[id]/send, Failed-bucket dismiss,
// POST /api/drips/forecast-skip, validation on prepare + forecast-skip.
//
// Run: node scripts/drips-e2e-test.mjs   (override port: DRIPS_E2E_PORT=3001)
// Requires: /tmp/drips-cookies.txt + dev server (default localhost:3001).

import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"

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
const BASE = `http://localhost:${process.env.DRIPS_E2E_PORT || 3001}`
const COOKIE = "/tmp/drips-cookies.txt"

function curl(method, path, body) {
  const args = ["-sS", "-b", COOKIE, "-X", method, `${BASE}${path}`]
  if (body) args.push("-H", "Content-Type: application/json", "-d", JSON.stringify(body))
  const result = execSync(`curl ${args.map(a => JSON.stringify(a)).join(" ")}`, { encoding: "utf8" })
  return JSON.parse(result)
}

function assert(cond, msg) { if (!cond) { console.error("✗ FAIL:", msg); process.exit(1) } else console.log("✓", msg) }

const initial = curl("GET", "/api/drips")
assert(
  Array.isArray(initial.late) && Array.isArray(initial.due) && Array.isArray(initial.failed) &&
  Array.isArray(initial.comingUp) && Array.isArray(initial.recentSent),
  "GET returns 5 buckets (late, due, failed, comingUp, recentSent)"
)
const anonForecasts = initial.comingUp.filter(c => "kind" in c && c.caller_phone === "Anonymous")
assert(anonForecasts.length === 0, "Anonymous filtered from forecast")
const forecastRows = initial.comingUp.filter(c => "kind" in c)
assert(forecastRows.every(c => typeof c.due_now === "boolean"), "every forecast row carries a due_now boolean")
assert(initial.failed.every(c => "error" in c), "every failed row carries an error field")
const totalMergedSiblings = initial.comingUp.reduce((acc, c) => acc + ("kind" in c ? (c.merged_siblings || 0) : 0), 0)
console.log(`  (info: total merged siblings = ${totalMergedSiblings}, failed = ${initial.failed.length})`)

const { data: leads } = await sb
  .from("leads")
  .select("id, name, caller_phone, drip_campaign_type, drip_touch_number")
  .not("drip_campaign_type", "is", null)
  .limit(1)
const lead = leads[0]
console.log(`Using lead: ${lead.name || lead.caller_phone} (${lead.id})`)

const { data: inserted } = await sb
  .from("drip_queue")
  .insert({ lead_id: lead.id, touch_number: 99, campaign_type: lead.drip_campaign_type, channel: "imessage", message: "[E2E] original", status: "pending" })
  .select().single()
const testId = inserted.id
console.log(`Seeded pending row: ${testId}`)

try {
  const editRes = curl("PATCH", "/api/leads/drip-queue", { id: testId, action: "edit", message: "[E2E] edited" })
  assert(editRes.item?.message === "[E2E] edited", "Edit endpoint updates message")

  const sendRes = curl("POST", `/api/drips/${testId}/send`)
  assert(sendRes.ok === true, `Send returned ok (got: ${JSON.stringify(sendRes)})`)
  const { data: afterSend } = await sb.from("drip_queue").select("status, approved_at").eq("id", testId).single()
  assert(["approved", "sent"].includes(afterSend.status), `Row flipped (got: ${afterSend.status})`)
  assert(afterSend.approved_at !== null, "approved_at stamped")

  const editAfter = curl("PATCH", "/api/leads/drip-queue", { id: testId, action: "edit", message: "should fail" })
  assert(editAfter.error, "Edit after approve returns error")
} finally {
  await sb.from("drip_queue").delete().eq("id", testId)
  console.log(`Cleaned up test row ${testId}`)
}

const forecastItem = initial.comingUp.find(c => "kind" in c)
if (forecastItem) {
  const { data: beforeSkip } = await sb.from("leads").select("drip_touch_number, last_drip_sent_at").eq("id", forecastItem.lead_id).single()
  const skipRes = curl("POST", "/api/drips/forecast-skip", { leadId: forecastItem.lead_id })
  assert(skipRes.ok === true, `forecast-skip returns ok (got: ${JSON.stringify(skipRes)})`)
  const { data: afterSkip } = await sb.from("leads").select("drip_touch_number").eq("id", forecastItem.lead_id).single()
  assert(afterSkip.drip_touch_number > (beforeSkip.drip_touch_number ?? -1), `drip_touch_number advanced (${beforeSkip.drip_touch_number} → ${afterSkip.drip_touch_number})`)
  await sb.from("leads").update({ drip_touch_number: beforeSkip.drip_touch_number, last_drip_sent_at: beforeSkip.last_drip_sent_at }).eq("id", forecastItem.lead_id)
  console.log(`  (restored ${forecastItem.lead_id})`)
}

// Failed-bucket dismiss: a failed row can be skipped via PATCH skip.
const { data: failedRow } = await sb
  .from("drip_queue")
  .insert({ lead_id: lead.id, touch_number: 98, campaign_type: lead.drip_campaign_type, channel: "imessage", message: "[E2E] failed", status: "failed", error: "[E2E] sidecar send 404" })
  .select().single()
try {
  const dismissRes = curl("PATCH", "/api/leads/drip-queue", { id: failedRow.id, action: "skip" })
  assert(dismissRes.item?.status === "skipped", `Failed row dismisses to skipped (got: ${JSON.stringify(dismissRes)})`)
} finally {
  await sb.from("drip_queue").delete().eq("id", failedRow.id)
  console.log(`Cleaned up failed test row ${failedRow.id}`)
}

const skipBadUuid = curl("POST", "/api/drips/forecast-skip", { leadId: "not-a-uuid" })
assert(skipBadUuid.error, "forecast-skip rejects non-uuid")

const prepBadUuid = curl("POST", "/api/drips/prepare", { leadId: "not-a-uuid" })
assert(prepBadUuid.error, "prepare rejects non-uuid")
const prepNoBody = curl("POST", "/api/drips/prepare", {})
assert(prepNoBody.error, "prepare rejects missing leadId")

console.log("\n=== ALL CHECKS PASSED ===")
