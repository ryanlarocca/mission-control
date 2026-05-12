#!/usr/bin/env node
// Batch rescue every orphaned call/voicemail row in the last N hours.
//
// For each row with recording_url IS NULL, finds the matching Twilio
// Recording by (call.from == caller_phone AND call.to == twilio_number),
// then replays Twilio's recordingStatusCallback against
// /api/leads/voice/recording so the existing pipeline (attach → Whisper →
// AI → Telegram) runs end-to-end.
//
// Usage:
//   node scripts/rescue-all-orphan-recordings.mjs              # last 72h, dry-run
//   node scripts/rescue-all-orphan-recordings.mjs --execute    # actually rescue
//   node scripts/rescue-all-orphan-recordings.mjs --hours=24 --execute

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

const args = process.argv.slice(2)
const execute = args.includes("--execute")
const hoursArg = args.find(a => a.startsWith("--hours="))
const hours = hoursArg ? parseInt(hoursArg.split("=")[1], 10) : 72

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)
const tw = { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN }
if (!tw.sid || !tw.token) { console.error("Missing Twilio creds"); process.exit(1) }
const auth = Buffer.from(`${tw.sid}:${tw.token}`).toString("base64")
const prodBase = "https://mission-control-three-chi.vercel.app"

const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
console.log(`Mode: ${execute ? "EXECUTE" : "DRY-RUN"}    window: last ${hours}h (since ${sinceIso})`)

// ── Step 1: load orphans ────────────────────────────────────────────────────
const { data: orphans, error } = await sb
  .from("leads")
  .select("id, caller_phone, twilio_number, lead_type, created_at, name")
  .is("recording_url", null)
  .in("lead_type", ["call", "voicemail"])
  .gte("created_at", sinceIso)
  .order("created_at", { ascending: false })
if (error) { console.error("orphan lookup failed:", error.message); process.exit(1) }
console.log(`Found ${orphans.length} orphaned call/voicemail row(s).`)
if (orphans.length === 0) process.exit(0)

// ── Step 2: pull all Twilio Recordings in window (paginate if needed) ───────
console.log(`Fetching Twilio Recordings in window...`)
let allRecordings = []
let nextUrl = `https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Recordings.json?DateCreatedAfter=${encodeURIComponent(sinceIso)}&PageSize=200`
while (nextUrl) {
  const r = await fetch(nextUrl, { headers: { Authorization: `Basic ${auth}` } })
  if (!r.ok) { console.error(`Twilio ${r.status}: ${await r.text()}`); process.exit(1) }
  const body = await r.json()
  allRecordings.push(...(body.recordings || []))
  nextUrl = body.next_page_uri ? `https://api.twilio.com${body.next_page_uri}` : null
}
console.log(`  → ${allRecordings.length} recording(s) total.`)

// ── Step 3: fetch each unique Call resource once (for From/To matching) ─────
const uniqueCallSids = Array.from(new Set(allRecordings.map(r => r.call_sid).filter(Boolean)))
console.log(`Fetching ${uniqueCallSids.length} unique Call resource(s)...`)
const callBySid = new Map()
let callsFetched = 0
for (const callSid of uniqueCallSids) {
  const cr = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Calls/${callSid}.json`, { headers: { Authorization: `Basic ${auth}` } })
  if (cr.ok) {
    callBySid.set(callSid, await cr.json())
    callsFetched++
  }
}
console.log(`  → cached ${callsFetched} call(s).`)

// ── Step 4: match orphans to recordings ─────────────────────────────────────
const plan = []
const unmatched = []
for (const o of orphans) {
  const orphanTs = new Date(o.created_at).getTime()
  const candidates = []
  for (const rec of allRecordings) {
    const call = callBySid.get(rec.call_sid)
    if (!call) continue
    const fromMatch = call.from === o.caller_phone
    const toMatch = o.twilio_number ? call.to === o.twilio_number : true
    if (!fromMatch || !toMatch) continue
    const deltaSec = Math.round((new Date(rec.date_created).getTime() - orphanTs) / 1000)
    // Reasonable proximity: call recording must be within ±1h of the lead row.
    if (Math.abs(deltaSec) > 3600) continue
    candidates.push({ rec, deltaSec })
  }
  if (candidates.length === 0) { unmatched.push(o); continue }
  candidates.sort((a, b) => Math.abs(a.deltaSec) - Math.abs(b.deltaSec))
  plan.push({ orphan: o, recording: candidates[0].rec, deltaSec: candidates[0].deltaSec })
}

console.log("")
console.log(`Plan: ${plan.length} matched, ${unmatched.length} unmatched.`)
for (const p of plan) {
  console.log(`  RESCUE ${p.orphan.created_at}  ${p.orphan.lead_type.padEnd(10)} ${(p.orphan.name||"(no name)").padEnd(15)} ${p.orphan.caller_phone.padEnd(15)} → ${p.orphan.twilio_number||"—"}  rec=${p.recording.sid} Δt=${p.deltaSec}s dur=${p.recording.duration}s`)
}
for (const u of unmatched) {
  console.log(`  SKIP   ${u.created_at}  ${u.lead_type.padEnd(10)} ${(u.name||"(no name)").padEnd(15)} ${u.caller_phone}  (no Twilio recording matched)`)
}

if (!execute) {
  console.log("\nDry-run — re-run with --execute to perform the rescues.")
  process.exit(0)
}

// ── Step 5: execute rescues. POST to /api/leads/voice/recording in series ───
// with a 3s gap so we don't pile waitUntil(Whisper+AI) jobs onto Vercel.
console.log("\nExecuting rescues...")
let ok = 0, fail = 0
for (const p of plan) {
  // Clear any prior bad URL so the route's idempotency check doesn't skip.
  const recordingBaseUrl = `https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Recordings/${p.recording.sid}`
  const form = new URLSearchParams({
    RecordingUrl: recordingBaseUrl,
    RecordingSid: p.recording.sid,
    RecordingDuration: String(p.recording.duration || ""),
    From: p.orphan.caller_phone,
    To: p.orphan.twilio_number || "",
    CallSid: p.recording.call_sid,
    // Tells the webhook to skip its time-windowed lookup and attach to
    // this exact orphan row instead of creating a fallback voicemail row.
    LeadId: p.orphan.id,
  })
  try {
    const wr = await fetch(`${prodBase}/api/leads/voice/recording`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    })
    if (wr.ok) {
      console.log(`  ✓ ${p.orphan.id}  rec=${p.recording.sid}`)
      ok++
    } else {
      console.log(`  ✗ ${p.orphan.id}  HTTP ${wr.status}: ${(await wr.text()).slice(0, 200)}`)
      fail++
    }
  } catch (e) {
    console.log(`  ✗ ${p.orphan.id}  threw: ${e.message}`)
    fail++
  }
  await new Promise(r => setTimeout(r, 3000))
}
console.log(`\nDone. ${ok} rescued, ${fail} failed.`)
