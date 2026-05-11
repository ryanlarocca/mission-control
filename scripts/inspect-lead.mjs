#!/usr/bin/env node
// Inspect everything about a lead end-to-end — what Mission Control sees,
// what's in Supabase, what the drip engine would do.
//
// Usage:
//   node scripts/inspect-lead.mjs +14084585442          # by phone (E.164)
//   node scripts/inspect-lead.mjs <uuid>                # by leads.id
//   node scripts/inspect-lead.mjs joyce@example.com     # by email
//
// Output sections:
//   1. Cluster — every leads row for this phone/email (the "card" in MC)
//   2. UI view — what the MC Leads tab would surface (name, source, status,
//      flags, temperature, last event, why-not-shown if filtered)
//   3. AI fields — which triage outputs are populated vs missing
//   4. Drip queue — pending / approved / sent / failed touches for the cluster
//   5. DNC list — if the phone or email is on dnc_list
//   6. Engine forecast — what touch the drip engine would queue if it ran
//      this minute, or the reason it would skip
//   7. Gaps — flagged issues (missing AI fields, stale drafts, etc.)

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

const arg = process.argv[2]
if (!arg) {
  console.error("Usage: node scripts/inspect-lead.mjs <phone | uuid | email>")
  process.exit(1)
}

// ── Resolve the cluster ─────────────────────────────────────────────────────
let lookupCol, lookupVal
if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg)) {
  // Look up the row by id first, then pivot to phone/email for the full cluster.
  const { data: seed } = await sb.from("leads")
    .select("id, caller_phone, email")
    .eq("id", arg)
    .maybeSingle()
  if (!seed) { console.error(`No lead with id=${arg}`); process.exit(1) }
  if (seed.caller_phone)      { lookupCol = "caller_phone"; lookupVal = seed.caller_phone }
  else if (seed.email)        { lookupCol = "email";        lookupVal = seed.email }
  else                        { lookupCol = "id";           lookupVal = seed.id }
} else if (arg.startsWith("+")) {
  lookupCol = "caller_phone"; lookupVal = arg
} else if (arg.includes("@")) {
  lookupCol = "email"; lookupVal = arg.toLowerCase()
} else if (/^\d{10,11}$/.test(arg)) {
  lookupCol = "caller_phone"; lookupVal = arg.length === 10 ? `+1${arg}` : `+${arg}`
} else {
  console.error(`Can't interpret '${arg}' as phone, email, or uuid`)
  process.exit(1)
}

const { data: rows, error } = await sb.from("leads")
  .select("*")
  .eq(lookupCol, lookupVal)
  .order("created_at", { ascending: false })

if (error) { console.error("query failed:", error.message); process.exit(1) }
if (!rows || rows.length === 0) {
  console.log(`No leads rows for ${lookupCol}=${lookupVal}`)
  process.exit(0)
}

const phone = rows.find(r => r.caller_phone)?.caller_phone || null
const email = rows.find(r => r.email)?.email || null

// ── Section 1: cluster ──────────────────────────────────────────────────────
const hr = "─".repeat(78)
console.log(hr)
console.log(`LEAD CLUSTER  ${lookupCol}=${lookupVal}  (${rows.length} row${rows.length === 1 ? "" : "s"})`)
console.log(hr)
for (const r of rows) {
  const flags = [
    r.is_dnc       && "DNC",
    r.is_junk      && "JUNK",
    r.is_bad_number&& "BAD#",
  ].filter(Boolean).join(",")
  console.log(`  ${r.created_at}  ${r.lead_type.padEnd(14)} ${r.status.padEnd(10)} ${r.source || "—"} (${r.source_type || "—"})`)
  console.log(`    id=${r.id}  drip=${r.drip_campaign_type || "—"} touch=${r.drip_touch_number ?? "—"}  flags=${flags || "—"}`)
  if (r.message) console.log(`    msg: "${r.message.slice(0, 100)}${r.message.length > 100 ? "…" : ""}"`)
  if (r.recording_url) console.log(`    🎙  ${r.recording_url}`)
}

// ── Section 2: UI view (what MC Leads tab would show on the card) ───────────
// Mirrors LeadsTab grouping: name = first non-null in cluster, source = most
// recent event's source, status = most recent event's status, mostRecent =
// row[0].
const ui = {
  phone,
  email,
  name:        rows.map(r => r.name).find(Boolean) || null,
  source:      rows[0].source,
  status:      rows[0].status,
  temperature: rows.map(r => r.temperature).find(Boolean) || null,
  isDnc:       rows.some(r => r.is_dnc),
  isJunk:      rows.some(r => r.is_junk),
  isBadNumber: rows.some(r => r.is_bad_number),
  onDrip:      rows.some(r => r.drip_campaign_type),
  mostRecentEvent: rows[0].lead_type,
  mostRecentAt:    rows[0].created_at,
  eventCount: rows.length,
}
console.log("")
console.log(hr); console.log("UI VIEW (Mission Control Leads tab card)"); console.log(hr)
for (const [k, v] of Object.entries(ui)) console.log(`  ${k.padEnd(18)} ${v ?? "—"}`)

const filterHints = []
if (ui.isDnc)        filterHints.push("card hidden by default 'Hide DNC' filter")
if (ui.isJunk)       filterHints.push("card hidden by default 'Hide Junk' filter")
if (ui.isBadNumber)  filterHints.push("card hidden by default 'Hide Bad #' filter")
if (ui.status === "dead") filterHints.push("status=dead — hidden under most lifecycle filters")
if (filterHints.length) {
  console.log("")
  console.log("  ⚠  potential filter reasons the card may not appear in MC:")
  for (const h of filterHints) console.log(`     - ${h}`)
}

// ── Section 3: AI fields ────────────────────────────────────────────────────
// Two parallel analyzer paths populate different column sets:
//   • voicemail/call → analyzeCallTranscript() → ai_summary, temperature,
//     recommended_followup_date, followup_reason
//   • email/sms      → triageEmailLead() → ai_notes, suggested_reply,
//     suggested_status, suggested_status_reason
// Empty fields outside a row's "lane" are EXPECTED, not bugs.
console.log("")
console.log(hr); console.log("AI / TRIAGE FIELDS (most recent row only)"); console.log(hr)
const top = rows[0]
const isVoiceRow = top.lead_type === "voicemail" || top.lead_type === "call"
const isEmailRow = top.lead_type === "email" || top.lead_type === "sms" || top.lead_type === "form"
const aiFields = [
  ["ai_summary",                top.ai_summary,                isVoiceRow],
  ["ai_summary_generated_at",   top.ai_summary_generated_at,   isVoiceRow],
  ["recommended_followup_date", top.recommended_followup_date, isVoiceRow],
  ["followup_reason",           top.followup_reason,           isVoiceRow],
  ["temperature",               top.temperature,               true],
  ["ai_notes",                  top.ai_notes,                  isEmailRow],
  ["suggested_reply",           top.suggested_reply,           isEmailRow],
  ["suggested_status",          top.suggested_status,          isEmailRow],
  ["suggested_status_reason",   top.suggested_status_reason,   isEmailRow],
]
for (const [k, v, expected] of aiFields) {
  let mark, tail
  if (v) {
    mark = "✓"
    tail = typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "…" : v
  } else {
    mark = expected ? "✗" : "·"
    tail = expected ? "(empty — expected populated)" : "(empty — N/A for this lead_type)"
  }
  console.log(`  ${mark} ${k.padEnd(28)} ${tail}`)
}

// ── Section 4: drip queue ───────────────────────────────────────────────────
const leadIds = rows.map(r => r.id)
const { data: queue } = await sb.from("drip_queue")
  .select("id, lead_id, touch_number, channel, status, message, subject, created_at, sent_at, error")
  .in("lead_id", leadIds)
  .order("created_at", { ascending: false })
  .limit(20)
console.log("")
console.log(hr); console.log(`DRIP QUEUE (${queue?.length || 0} row${queue?.length === 1 ? "" : "s"} across cluster)`); console.log(hr)
if (queue && queue.length) {
  for (const q of queue) {
    const ts = q.sent_at || q.created_at
    console.log(`  ${ts}  #${q.touch_number} ${q.channel.padEnd(8)} ${q.status.padEnd(9)} ${q.error ? "err=" + q.error : ""}`)
    if (q.subject) console.log(`    subject: ${q.subject}`)
    if (q.message) console.log(`    msg: "${q.message.slice(0, 100)}${q.message.length > 100 ? "…" : ""}"`)
  }
} else {
  console.log("  (no drip queue rows)")
}

// ── Section 5: DNC list ─────────────────────────────────────────────────────
const dncIds = []
if (phone) dncIds.push({ col: "phone", val: phone })
if (email) dncIds.push({ col: "email", val: email })
console.log("")
console.log(hr); console.log("DNC LIST"); console.log(hr)
let dncHits = 0
for (const { col, val } of dncIds) {
  const { data: hit } = await sb.from("dnc_list").select("*").eq(col, val).maybeSingle()
  if (hit) {
    dncHits++
    console.log(`  ⛔ ${col}=${val}  reason=${hit.reason}  added=${hit.created_at}`)
    if (hit.notes) console.log(`     notes: ${hit.notes}`)
  }
}
if (dncHits === 0) console.log("  (not on dnc_list)")

// ── Section 6: engine forecast ──────────────────────────────────────────────
console.log("")
console.log(hr); console.log("ENGINE FORECAST (what /scripts/drip-engine.js would do)"); console.log(hr)
// Pick the most recent drip-eligible row (has drip_campaign_type, status not dead/active)
const eligible = rows.find(r => r.drip_campaign_type)
if (!eligible) {
  console.log("  • no drip_campaign_type on any row — not on a drip cadence")
} else {
  const stops = ["active", "dead"]
  const reasons = []
  if (stops.includes(eligible.status)) reasons.push(`status=${eligible.status} (stop status)`)
  if (eligible.is_dnc)  reasons.push("is_dnc=true")
  if (eligible.is_junk) reasons.push("is_junk=true")
  const pending = queue?.find(q => q.status === "pending" || q.status === "approved")
  if (pending) reasons.push(`pending queue row id=${pending.id} (status=${pending.status})`)
  // Hold-on-activity check: any non-drip row newer than last_drip_sent_at?
  if (eligible.last_drip_sent_at) {
    const newer = rows.find(r =>
      new Date(r.created_at) > new Date(eligible.last_drip_sent_at) &&
      r.lead_type &&
      !r.lead_type.startsWith("drip_")
    )
    if (newer) reasons.push(`recent human activity (${newer.lead_type} at ${newer.created_at}) — engine holds`)
  }
  console.log(`  • eligible row: ${eligible.id}`)
  console.log(`  • campaign=${eligible.drip_campaign_type}  touch=${eligible.drip_touch_number ?? "—"}  last_sent=${eligible.last_drip_sent_at || "—"}`)
  if (reasons.length) {
    console.log("  • engine would SKIP, reasons:")
    for (const r of reasons) console.log(`     - ${r}`)
  } else {
    console.log("  • engine would queue next touch on its next hourly pass")
  }
}

// ── Section 7: gaps / red flags ─────────────────────────────────────────────
console.log("")
console.log(hr); console.log("GAPS / RED FLAGS"); console.log(hr)
const gaps = []
const hasRecording = rows.some(r => r.recording_url)
if (hasRecording && !top.ai_summary) gaps.push("recording present but ai_summary is null — Whisper/AI may have failed")
if (top.lead_type === "voicemail" && !top.ai_summary) gaps.push("voicemail without ai_summary — analyzer may not have run")
if (top.lead_type === "call" && !top.recording_url) gaps.push("call without recording_url — Twilio recordingStatusCallback may not have fired")
if (isEmailRow && top.lead_type === "email" && !top.ai_notes) gaps.push("email without ai_notes — triage may have failed")
if (isEmailRow && top.lead_type === "email" && !top.suggested_reply) gaps.push("email without suggested_reply — drafter may have failed")
if (eligible && eligible.drip_campaign_type === "direct_mail_call" && top.source === "Google") {
  gaps.push("source=Google but drip_campaign_type=direct_mail_call — drip routing mismatch (run Apply Drip again)")
}
if (eligible && eligible.last_drip_sent_at) {
  const hoursSince = (Date.now() - new Date(eligible.last_drip_sent_at).getTime()) / 3600000
  if (hoursSince > 168 && !rows.some(r => r.lead_type.startsWith("drip_"))) {
    gaps.push(`${Math.round(hoursSince)}h since last_drip_sent_at but no drip_* event row — engine may have stalled`)
  }
}
if (gaps.length === 0) console.log("  (none — looks healthy)")
else for (const g of gaps) console.log(`  ⚠  ${g}`)
console.log("")
