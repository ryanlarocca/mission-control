#!/usr/bin/env node
// Rescue an orphaned call/voicemail row by replaying what Twilio's
// recordingStatusCallback would have done if it fired. Queries Twilio's
// Recordings API for a recording matching the lead's caller_phone +
// twilio_number near the row's created_at, then POSTs Twilio-shaped form
// data to /api/leads/voice/recording so the existing pipeline (attach →
// Whisper → AI → Telegram) runs end-to-end. No new code paths, no new auth.
//
// Usage:
//   node scripts/rescue-call-recording.mjs <leadId>
//
// Why this is needed: voice/route.ts relies on Twilio's
// recordingStatusCallback, which is known to fire unreliably (see the
// header comment in no-answer/route.ts). Until the general
// "Missing recording" pipeline lands, this script is the manual rescue.

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

const leadId = process.argv[2]
if (!leadId) {
  console.error("Usage: node scripts/rescue-call-recording.mjs <leadId>")
  process.exit(1)
}

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)
const tw = { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN }
if (!tw.sid || !tw.token) { console.error("Missing Twilio creds"); process.exit(1) }

// ── Step 1: load the lead row ────────────────────────────────────────────────
const { data: lead, error: leadErr } = await sb
  .from("leads")
  .select("id, caller_phone, twilio_number, lead_type, created_at, recording_url, name")
  .eq("id", leadId)
  .maybeSingle()
if (leadErr || !lead) { console.error("Lead not found:", leadErr?.message); process.exit(1) }
console.log(`Lead ${lead.id}: ${lead.lead_type} from ${lead.caller_phone} → ${lead.twilio_number} at ${lead.created_at}  (name=${lead.name||"—"})`)
console.log(`Current recording_url: ${lead.recording_url || "(null)"}`)

// ── Step 2: query Twilio Recordings API ──────────────────────────────────────
const callTs = new Date(lead.created_at).getTime()
const winStart = new Date(callTs - 10 * 60 * 1000).toISOString()
const winEnd = new Date(callTs + 60 * 60 * 1000).toISOString()
const auth = Buffer.from(`${tw.sid}:${tw.token}`).toString("base64")
const recUrl = `https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Recordings.json?DateCreatedAfter=${encodeURIComponent(winStart)}&DateCreatedBefore=${encodeURIComponent(winEnd)}&PageSize=100`
const recRes = await fetch(recUrl, { headers: { Authorization: `Basic ${auth}` } })
if (!recRes.ok) { console.error(`Twilio ${recRes.status}: ${await recRes.text()}`); process.exit(1) }
const recBody = await recRes.json()
const recordings = recBody.recordings || []
console.log(`Twilio returned ${recordings.length} recording(s) in window ${winStart} → ${winEnd}`)

// ── Step 3: match against From/To via the Call resource ──────────────────────
const matched = []
for (const r of recordings) {
  const cr = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Calls/${r.call_sid}.json`, { headers: { Authorization: `Basic ${auth}` } })
  if (!cr.ok) continue
  const call = await cr.json()
  const fromMatch = call.from === lead.caller_phone
  const toMatch = lead.twilio_number ? call.to === lead.twilio_number : true
  if (fromMatch && toMatch) {
    const deltaSec = Math.round((new Date(r.date_created).getTime() - callTs) / 1000)
    matched.push({ recording: r, call, deltaSec })
  }
}
if (matched.length === 0) { console.error("No recordings matched From/To — nothing to rescue."); process.exit(1) }
matched.sort((a, b) => Math.abs(a.deltaSec) - Math.abs(b.deltaSec))
const winner = matched[0]
console.log(`✓ MATCH: ${winner.recording.sid}  call=${winner.recording.call_sid}  duration=${winner.recording.duration}s  Δt=${winner.deltaSec}s`)

// ── Step 4: build the Twilio-style RecordingUrl (no extension; the route   ──
// adds ".mp3"). Format mirrors what Twilio sends to recordingStatusCallback.
const recordingBaseUrl = `https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Recordings/${winner.recording.sid}`

// ── Step 5: clear any bad recording_url first so the route's idempotency  ──
// check doesn't short-circuit. We're effectively replaying the webhook.
if (lead.recording_url) {
  await sb.from("leads").update({ recording_url: null }).eq("id", lead.id)
  console.log(`Cleared prior recording_url to allow webhook replay.`)
}

// ── Step 6: POST to /api/leads/voice/recording — same shape Twilio uses ─────
const prodBase = "https://mission-control-three-chi.vercel.app"
const webhookUrl = `${prodBase}/api/leads/voice/recording`
const form = new URLSearchParams({
  RecordingUrl: recordingBaseUrl,
  RecordingSid: winner.recording.sid,
  RecordingDuration: String(winner.recording.duration || ""),
  From: lead.caller_phone,
  To: lead.twilio_number || "",
  CallSid: winner.recording.call_sid,
})
console.log(`POSTing to ${webhookUrl} ...`)
const wr = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: form.toString(),
})
const wrBody = await wr.text()
console.log(`webhook → ${wr.status}  ${wrBody.slice(0, 300)}`)

// ── Step 7: verify recording_url landed on the row ──────────────────────────
const { data: updated } = await sb.from("leads").select("recording_url").eq("id", lead.id).maybeSingle()
console.log(`Final recording_url: ${updated?.recording_url || "(still null — webhook may have failed)"}`)
console.log(`\nNow waiting on background processRecordingBackground (Whisper + AI). Re-run scripts/inspect-lead.mjs ${lead.caller_phone} in ~30s to verify transcript + summary landed.`)
