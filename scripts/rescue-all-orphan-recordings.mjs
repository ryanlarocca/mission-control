#!/usr/bin/env node
// Batch rescue every orphaned call/voicemail row in the last N hours.
// Runs every 15 min on the Mac mini (launchd com.lrghomes.orphan-recording-rescue).
//
// Phase A — orphans: rows with recording_url IS NULL. Finds the matching
// Twilio Recording by (call.from == caller_phone AND call.to ==
// twilio_number), then replays Twilio's recordingStatusCallback against
// /api/leads/voice/recording so the existing pipeline (attach → Whisper →
// AI → Telegram) runs end-to-end.
//
// Phase B — untranscribed: rows that HAVE a recording_url but no transcript
// (message IS NULL). The webhook attached the URL and then the download /
// Whisper / function budget failed. Replays the same callback; the webhook
// re-runs the pipeline on a row whose transcript never landed.
//
// Phase C — unanalyzed: inbound rows with a transcript but no ai_summary
// (the AI analyzer failed after Whisper succeeded). POSTs the card's own
// re-analyze route with {silent:true}. Needs MC_PASSWORD in .env.local.
//
// Every phase only touches COMPLETED recordings on COMPLETED calls, and
// waits SETTLE_MIN minutes after the call ends so Twilio's own callback
// gets first crack (otherwise the sweep and the callback run the same
// Whisper + analysis twice within seconds of each other). On
// 2026-09-22 this sweep fired 11 minutes into a live 20-minute call
// (Glenda McGovern, 533 Vine St): the row had no recording_url yet because
// the call hadn't ended, Twilio listed an in-progress recording
// (duration -1), the "rescue" attached it, the download came back empty,
// the lead was stamped "left no message", and the real callback 9 minutes
// later was dropped as a duplicate. Never again.
//
// Usage:
//   node scripts/rescue-all-orphan-recordings.mjs              # last 72h, dry-run
//   node scripts/rescue-all-orphan-recordings.mjs --execute    # actually rescue
//   node scripts/rescue-all-orphan-recordings.mjs --hours=24 --execute

import { createClient } from "@supabase/supabase-js"
import { readFileSync, writeFileSync, existsSync } from "node:fs"

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

// A recording is only usable once Twilio has finished it. `duration` is
// "-1" and status "in-progress" while the call is still live.
const recordingReady = rec => rec.status === "completed" && Number(rec.duration) >= 0
const callEnded = call => !call || !["queued", "ringing", "in-progress"].includes(call.status)
// Under ~12s there's nothing to transcribe (hang-up on the greeting); the
// webhook applies its cold default to those itself, so don't loop on them.
const MIN_TRANSCRIBABLE_SEC = 12
// Give Twilio's real recordingStatusCallback + the webhook's own pipeline
// (10s settle + download + Whisper on a 30-min call + analysis ≈ 3-4 min)
// time to finish before we step in.
const SETTLE_MIN = 6
const settled = iso => !iso || (Date.now() - new Date(iso).getTime()) > SETTLE_MIN * 60 * 1000
// Bounded retries per row across every phase (state in /tmp — a reboot
// just grants a few extra attempts). A row that fails every time already
// raised a Telegram alert from the webhook; stop hammering after 3.
const STATE_PATH = "/tmp/lrg-retranscribe-attempts.json"
const MAX_ATTEMPTS = 3
let attempts = {}
try { if (existsSync(STATE_PATH)) attempts = JSON.parse(readFileSync(STATE_PATH, "utf8")) } catch { attempts = {} }
function persistAttempts() {
  if (!execute) return
  try { writeFileSync(STATE_PATH, JSON.stringify(attempts)) } catch (e) { console.warn("could not persist attempt state:", e.message) }
}

// Replay Twilio's recordingStatusCallback for one (row, recording) pair.
// Outbound rows (twilio_number NULL — the /api/leads/call convention) go
// to the outbound webhook so they get the outbound summary path, not
// inbound triage.
async function replayCallback({ leadId, callerPhone, twilioNumber, rec }) {
  const recordingBaseUrl = `https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Recordings/${rec.sid}`
  const form = new URLSearchParams({
    RecordingUrl: recordingBaseUrl,
    RecordingSid: rec.sid,
    RecordingStatus: rec.status || "completed",
    RecordingDuration: String(rec.duration ?? ""),
    From: callerPhone,
    To: twilioNumber || "",
    CallSid: rec.call_sid || "",
    // Tells the inbound webhook to skip its time-windowed lookup and
    // attach to this exact row instead of creating a fallback row.
    LeadId: leadId,
  })
  const endpoint = twilioNumber
    ? `${prodBase}/api/leads/voice/recording`
    : `${prodBase}/api/leads/call/recording?leadId=${encodeURIComponent(leadId)}`
  const wr = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })
  if (!wr.ok) throw new Error(`HTTP ${wr.status}: ${(await wr.text()).slice(0, 200)}`)
}

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
if (orphans.length === 0) {
  await phaseB()
  await phaseC()
  persistAttempts()
  process.exit(0)
}

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
// Greedy 1:1 assignment so two orphans (especially Anonymous voicemails
// with identical caller_phone="Anonymous") can't both claim the same
// recording. Process orphans newest-first; each orphan picks the closest
// still-unclaimed recording within ±1h, then that recording is removed
// from the candidate pool for subsequent orphans.
const claimed = new Set()
const plan = []
const unmatched = []
for (const o of orphans) {
  const orphanTs = new Date(o.created_at).getTime()
  const candidates = []
  for (const rec of allRecordings) {
    if (claimed.has(rec.sid)) continue
    const call = callBySid.get(rec.call_sid)
    if (!call) continue
    // Still recording / still on the phone → not an orphan, just in flight.
    // Just ended → Twilio's own callback is probably mid-pipeline; wait.
    if (!recordingReady(rec) || !callEnded(call) || !settled(call.end_time)) continue
    const fromMatch = call.from === o.caller_phone
    const toMatch = o.twilio_number ? call.to === o.twilio_number : true
    if (!fromMatch || !toMatch) continue
    const deltaSec = Math.round((new Date(rec.date_created).getTime() - orphanTs) / 1000)
    if (Math.abs(deltaSec) > 3600) continue
    candidates.push({ rec, deltaSec })
  }
  if (candidates.length === 0) { unmatched.push(o); continue }
  candidates.sort((a, b) => Math.abs(a.deltaSec) - Math.abs(b.deltaSec))
  const winner = candidates[0]
  claimed.add(winner.rec.sid)
  plan.push({ orphan: o, recording: winner.rec, deltaSec: winner.deltaSec })
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
  await phaseB()
  await phaseC()
  process.exit(0)
}

// ── Step 5: execute rescues. POST to /api/leads/voice/recording in series ───
// with a 3s gap so we don't pile waitUntil(Whisper+AI) jobs onto Vercel.
console.log("\nExecuting rescues...")
let ok = 0, fail = 0
for (const p of plan) {
  try {
    await replayCallback({ leadId: p.orphan.id, callerPhone: p.orphan.caller_phone, twilioNumber: p.orphan.twilio_number, rec: p.recording })
    console.log(`  ✓ ${p.orphan.id}  rec=${p.recording.sid}`)
    ok++
  } catch (e) {
    console.log(`  ✗ ${p.orphan.id}  ${e.message}`)
    fail++
  }
  await new Promise(r => setTimeout(r, 3000))
}
console.log(`\nDone. ${ok} rescued, ${fail} failed.`)
await phaseB()
await phaseC()
persistAttempts()

// ── Phase B: recording attached, transcript never landed ────────────────────
async function phaseB() {
  const { data: rows, error: qErr } = await sb
    .from("leads")
    .select("id, caller_phone, twilio_number, lead_type, created_at, name, recording_url")
    .not("recording_url", "is", null)
    .is("message", null)
    .in("lead_type", ["call", "voicemail"])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
  if (qErr) { console.error("phase B lookup failed:", qErr.message); return }
  console.log(`\nPhase B: ${rows.length} row(s) with a recording but no transcript.`)
  if (rows.length === 0) return

  let ok = 0, fail = 0, skipped = 0
  for (const row of rows) {
    const tag = `${String(row.created_at).slice(0, 16)} ${row.lead_type.padEnd(9)} ${(row.name || row.caller_phone || row.id).padEnd(15)}`
    const sidMatch = /Recordings\/(RE[0-9a-f]{32})/.exec(row.recording_url || "")
    if (!sidMatch) { console.log(`  SKIP ${tag} recording_url has no Twilio SID`); skipped++; continue }
    const sid = sidMatch[1]
    const rr = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Recordings/${sid}.json`, { headers: { Authorization: `Basic ${auth}` } })
    if (!rr.ok) { console.log(`  SKIP ${tag} Twilio ${rr.status} for ${sid}`); skipped++; continue }
    const rec = await rr.json()
    if (!recordingReady(rec)) { console.log(`  ${rec.status === "in-progress" ? "WAIT" : "SKIP"} ${tag} ${sid} status=${rec.status} dur=${rec.duration}s — not a finished recording`); skipped++; continue }
    if (Number(rec.duration) < MIN_TRANSCRIBABLE_SEC) { console.log(`  SKIP ${tag} ${sid} only ${rec.duration}s — nothing to transcribe`); skipped++; continue }
    if (!settled(rec.date_updated)) { console.log(`  WAIT ${tag} ${sid} finished <${SETTLE_MIN} min ago — webhook pipeline likely still running`); skipped++; continue }
    const n = attempts[row.id] || 0
    if (n >= MAX_ATTEMPTS) { console.log(`  GIVE UP ${tag} ${sid} after ${n} attempts`); skipped++; continue }
    console.log(`  ${execute ? "RETRY" : "WOULD RETRY"} ${tag} ${sid} dur=${rec.duration}s attempt=${n + 1}/${MAX_ATTEMPTS}`)
    if (!execute) continue
    attempts[row.id] = n + 1
    try {
      await replayCallback({ leadId: row.id, callerPhone: row.caller_phone, twilioNumber: row.twilio_number, rec })
      ok++
    } catch (e) {
      console.log(`  ✗ ${row.id}  ${e.message}`)
      fail++
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  if (execute) console.log(`Phase B done. ${ok} replayed, ${fail} failed, ${skipped} skipped.`)
}

// ── Phase C: transcript saved, AI analysis never ran ────────────────────────
// Inbound rows only (outbound rows use a different summary path). A row
// with `message` but no `ai_summary` after SETTLE_MIN means the analyzer
// threw / timed out after Whisper succeeded. Re-run it through the same
// route the card's re-analyze button uses.
async function phaseC() {
  const pw = process.env.MC_PASSWORD
  const { data: rows, error: qErr } = await sb
    .from("leads")
    .select("id, caller_phone, twilio_number, lead_type, created_at, name, message")
    .not("recording_url", "is", null)
    .not("message", "is", null)
    .is("ai_summary", null)
    .not("twilio_number", "is", null)
    .in("lead_type", ["call", "voicemail"])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
  if (qErr) { console.error("phase C lookup failed:", qErr.message); return }
  const due = rows.filter(r => (r.message || "").trim().length >= 40 && settled(r.created_at))
  console.log(`\nPhase C: ${due.length} row(s) with a transcript but no AI analysis.`)
  if (due.length === 0) return
  if (!pw) { console.warn("  MC_PASSWORD not set in .env.local — cannot call analyze-call; skipping Phase C"); return }

  let cookie = null
  if (execute) {
    const lr = await fetch(`${prodBase}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) })
    if (!lr.ok) { console.error(`  login failed HTTP ${lr.status}; skipping Phase C`); return }
    cookie = (lr.headers.get("set-cookie") || "").split(";")[0]
  }
  let ok = 0, fail = 0, skipped = 0
  for (const row of due) {
    const tag = `${String(row.created_at).slice(0, 16)} ${row.lead_type.padEnd(9)} ${(row.name || row.caller_phone || row.id).padEnd(15)}`
    const key = `analyze:${row.id}`
    const n = attempts[key] || 0
    if (n >= MAX_ATTEMPTS) { console.log(`  GIVE UP ${tag} after ${n} attempts`); skipped++; continue }
    console.log(`  ${execute ? "ANALYZE" : "WOULD ANALYZE"} ${tag} ${row.message.length} chars attempt=${n + 1}/${MAX_ATTEMPTS}`)
    if (!execute) continue
    attempts[key] = n + 1
    try {
      const ar = await fetch(`${prodBase}/api/leads/${row.id}/analyze-call`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ silent: true }) })
      const aj = await ar.json().catch(() => ({}))
      if (!ar.ok) throw new Error(`HTTP ${ar.status}: ${aj.error || ""}`)
      console.log(`  ✓ ${row.id} → ${aj.temperature || "?"}`)
      ok++
    } catch (e) {
      console.log(`  ✗ ${row.id}  ${e.message}`)
      fail++
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  if (execute) console.log(`Phase C done. ${ok} analyzed, ${fail} failed, ${skipped} skipped.`)
}
