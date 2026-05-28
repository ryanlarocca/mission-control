#!/usr/bin/env node
/**
 * retranscribe-missing — safety net for the call → transcript → analysis
 * pipeline. Finds call/voicemail leads that have a Twilio recording_url but an
 * empty transcript (message IS NULL) — the signature of a silent transcription
 * failure — then re-downloads the audio, re-runs Whisper, saves the transcript,
 * and re-runs the AI analysis (which sets temperature + summary + follow-up).
 *
 * This catches ANY silent failure regardless of root cause (transient OpenAI
 * error, background-time-budget kill, etc.), so a real conversation can never
 * stay lost / mislabeled "cold — left no message".
 *
 *   node scripts/retranscribe-missing.mjs           # recover all
 *   node scripts/retranscribe-missing.mjs --dry      # list only, no changes
 *   node scripts/retranscribe-missing.mjs --min 120  # skip recordings whose
 *                                                     # transcript is < 120 chars
 *
 * Reads from this repo's .env.local: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * OPENAI_API_KEY, LRG_SUPABASE_URL, LRG_SUPABASE_SERVICE_KEY, MC_PASSWORD,
 * optional MC_BASE_URL.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_PATH = path.resolve(__dirname, "../.env.local")
const DEFAULT_BASE = "https://mission-control-three-chi.vercel.app"
const DRY = process.argv.includes("--dry")
const MIN_CHARS = (() => { const i = process.argv.indexOf("--min"); return i >= 0 ? Number(process.argv[i + 1]) || 0 : 0 })()

function loadEnvLocal() {
  if (!fs.existsSync(ENV_PATH)) return
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("="); if (eq < 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[k] === undefined) process.env[k] = v
  }
}
function die(m) { console.error(`✗ ${m}`); process.exit(1) }

loadEnvLocal()
const SB_URL = process.env.LRG_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = process.env.LRG_SUPABASE_SERVICE_KEY
const TW_SID = process.env.TWILIO_ACCOUNT_SID
const TW_TOK = process.env.TWILIO_AUTH_TOKEN
const OAI = process.env.OPENAI_API_KEY
const BASE = (process.env.MC_BASE_URL || DEFAULT_BASE).replace(/\/$/, "")
const PW = process.env.MC_PASSWORD
for (const [n, v] of Object.entries({ SB_URL, SB_KEY, TW_SID, TW_TOK, OAI, PW })) if (!v) die(`missing env: ${n}`)

const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

async function login() {
  const r = await fetch(`${BASE}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PW }) })
  if (!r.ok) die(`login failed HTTP ${r.status}`)
  return (r.headers.get("set-cookie") || "").split(";")[0]
}

async function transcribe(buf) {
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/mpeg" }), "recording.mp3")
  form.append("model", "whisper-1")
  form.append("response_format", "text")
  for (let a = 1; a <= 3; a++) {
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${OAI}` }, body: form })
    if (r.ok) return (await r.text()).trim()
    if (r.status !== 429 && r.status < 500) { console.error(`  whisper ${r.status}: ${(await r.text()).slice(0, 150)}`); return null }
    await new Promise(res => setTimeout(res, 1500 * a))
  }
  return null
}

const q = `${SB_URL}/rest/v1/leads?select=id,name,caller_phone,lead_type,recording_url,created_at&recording_url=not.is.null&message=is.null&lead_type=in.(call,voicemail)&order=created_at.desc`
const victims = await (await fetch(q, { headers: sbHeaders })).json()
console.log(`Found ${victims.length} call/voicemail lead(s) with a recording but no transcript.${DRY ? " (dry run)" : ""}`)

const cookie = DRY ? null : await login()
let recovered = 0, skipped = 0, failed = 0

for (const v of victims) {
  const tag = `${String(v.created_at).slice(0, 16)} ${v.lead_type} ${v.name || v.caller_phone || v.id}`
  if (DRY) { console.log(`  • ${tag}`); continue }
  try {
    const url = v.recording_url.endsWith(".mp3") ? v.recording_url : `${v.recording_url}.mp3`
    const audioRes = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from(`${TW_SID}:${TW_TOK}`).toString("base64")}` } })
    if (!audioRes.ok) { console.log(`  ✗ ${tag} — audio fetch HTTP ${audioRes.status}`); failed++; continue }
    const buf = Buffer.from(await audioRes.arrayBuffer())
    const text = await transcribe(buf)
    if (!text || text.length < MIN_CHARS) { console.log(`  – ${tag} — transcript empty/too short (${text ? text.length : 0} chars), skipping`); skipped++; continue }
    const patch = await fetch(`${SB_URL}/rest/v1/leads?id=eq.${v.id}`, { method: "PATCH", headers: { ...sbHeaders, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ message: text }) })
    if (!patch.ok) { console.log(`  ✗ ${tag} — save HTTP ${patch.status}`); failed++; continue }
    const an = await fetch(`${BASE}/api/leads/${v.id}/analyze-call`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ silent: true }) })
    const aj = await an.json().catch(() => ({}))
    console.log(`  ✓ ${tag} — ${text.length} chars${aj.temperature ? `, ${aj.temperature}` : ""}${aj.recommended_followup_date ? `, follow-up ${aj.recommended_followup_date}` : ""}`)
    recovered++
  } catch (e) { console.log(`  ✗ ${tag} — ${e.message}`); failed++ }
}
if (!DRY) console.log(`\nDone. recovered=${recovered} skipped(empty)=${skipped} failed=${failed}`)
