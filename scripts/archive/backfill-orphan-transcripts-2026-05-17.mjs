#!/usr/bin/env node
// One-shot backfill for inbound recordings where Whisper silently dropped.
// Symptom: leads.recording_url is set, but leads.message is null AND
// leads.ai_summary either null or the cold-default placeholder. Pattern
// surfaced in the Gigi Williams debugging session 2026-05-17 — two prior
// 27-minute recordings (ef0869a0, 07fe00f3) plus Gigi's 11-minute one. The
// recording route now has maxDuration=300 so new ones shouldn't drop, but
// these legacy rows still need recovery.
//
// Flow per lead: pull mp3 from Twilio → Whisper → save message → POST
// analyze-call (auth'd with MC_SESSION_SECRET) so ai_summary / temperature /
// follow-up reflect the actual conversation.

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

const LEAD_IDS = [
  "ef0869a0-1234-1234-1234-000000000000".replace(/^ef0869a0-.*/, "ef0869a0"), // placeholder; filled by arg or auto-discover below
]

// If invoked with explicit ids, use those. Otherwise auto-discover any row in
// the last 30d with recording_url set + message null.
const explicitIds = process.argv.slice(2).filter(s => /^[0-9a-f-]{8,}$/.test(s))

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN
const OPENAI_KEY = process.env.OPENAI_API_KEY
const SESSION = process.env.MC_SESSION_SECRET
const PROD = "https://mission-control-three-chi.vercel.app"
const twAuth = "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64")

let targetIds
if (explicitIds.length > 0) {
  // Resolve short prefixes to full UUIDs.
  const resolved = []
  for (const prefix of explicitIds) {
    if (prefix.length === 36) { resolved.push(prefix); continue }
    const { data } = await sb.from("leads").select("id").like("id", `${prefix}%`).limit(2)
    if (!data || data.length === 0) { console.warn(`No row with id prefix ${prefix}`); continue }
    if (data.length > 1) { console.warn(`Ambiguous prefix ${prefix} (${data.length} matches); skipping`); continue }
    resolved.push(data[0].id)
  }
  targetIds = resolved
} else {
  const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString()
  const { data, error } = await sb.from("leads")
    .select("id, name, caller_phone, recording_url, message, created_at")
    .gte("created_at", since)
    .not("recording_url", "is", null)
    .is("message", null)
  if (error) { console.error(error); process.exit(1) }
  targetIds = (data ?? []).map(r => r.id)
  console.log(`Auto-discovered ${targetIds.length} orphan(s) in the last 30d.`)
}

if (targetIds.length === 0) { console.log("Nothing to backfill."); process.exit(0) }

for (const id of targetIds) {
  console.log(`\n=== ${id} ===`)
  const { data: lead, error } = await sb.from("leads")
    .select("id, name, caller_phone, recording_url, message")
    .eq("id", id).single()
  if (error || !lead) { console.warn(`Skip ${id}: ${error?.message || "not found"}`); continue }
  if (lead.message) { console.log(`  Already has transcript (${lead.message.length} chars). Skipping.`); continue }
  if (!lead.recording_url) { console.warn(`  No recording_url. Skipping.`); continue }
  console.log(`  ${lead.name || "(unknown)"}  ${lead.caller_phone || ""}`)

  // 1. Download audio
  const audioRes = await fetch(lead.recording_url, { headers: { Authorization: twAuth } })
  if (!audioRes.ok) { console.warn(`  Twilio fetch failed: ${audioRes.status}`); continue }
  const audioBuf = Buffer.from(await audioRes.arrayBuffer())
  console.log(`  Downloaded ${audioBuf.length} bytes`)

  // 2. Whisper
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(audioBuf)], { type: "audio/mpeg" }), "rec.mp3")
  form.append("model", "whisper-1")
  const wt0 = Date.now()
  const wres = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  })
  if (!wres.ok) { console.warn(`  Whisper ${wres.status}: ${(await wres.text()).slice(0, 200)}`); continue }
  const wjson = await wres.json()
  const transcript = (wjson.text || "").trim()
  console.log(`  Whisper ${Date.now() - wt0}ms — ${transcript.length} chars`)
  if (transcript.length < 20) { console.warn(`  Transcript too short, skipping save.`); continue }

  // 3. Save to message
  const { error: upErr } = await sb.from("leads").update({ message: transcript }).eq("id", id)
  if (upErr) { console.warn(`  Save failed: ${upErr.message}`); continue }

  // 4. Re-run analyze-call so summary/temp/follow-up reflect this transcript
  const aRes = await fetch(`${PROD}/api/leads/${id}/analyze-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `mc_session=${SESSION}` },
    body: JSON.stringify({ silent: true }),
  })
  if (!aRes.ok) { console.warn(`  analyze-call ${aRes.status}: ${(await aRes.text()).slice(0, 200)}`); continue }
  const aJson = await aRes.json()
  console.log(`  ✓ analyzed → ${aJson.temperature}: ${(aJson.summary || "").slice(0, 100)}`)
}

console.log("\nDone.")
