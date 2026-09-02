#!/usr/bin/env node
// Phase 7D backfill — re-run the unified analyzer against existing lead
// rows that have a transcript but are missing the new fields (temperature,
// name, property_address, ai_summary, recommended_followup_date).
//
// Usage:
//   node scripts/phase7d-backfill-analyzer.mjs <lead_id>          # one row
//   node scripts/phase7d-backfill-analyzer.mjs --all              # every row with a transcript
//   node scripts/phase7d-backfill-analyzer.mjs --dry-run <id|--all>  # print would-write, don't persist
//
// Loads env from .env.local. Uses raw REST + OpenRouter (no Next.js needed).

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")
for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
  const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (process.env[m[1]] === undefined) process.env[m[1]] = v
}

const SUPABASE_URL = process.env.LRG_SUPABASE_URL
const SUPABASE_KEY = process.env.LRG_SUPABASE_SERVICE_KEY
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing")
  process.exit(1)
}
if (!OPENROUTER_KEY) {
  console.error("OPENROUTER_API_KEY missing")
  process.exit(1)
}

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const all = args.includes("--all")
const idArg = args.find(a => !a.startsWith("--"))
if (!all && !idArg) {
  console.error("Usage: phase7d-backfill-analyzer.mjs <lead_id> | --all  [--dry-run]")
  process.exit(2)
}

const VALID_TEMPS = ["hot", "warm", "cold"]
const DEFAULT_FOLLOWUP_REASON = "Initial follow-up after inbound call."

function defaultFollowupDate() {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

async function analyze(transcript) {
  const today = new Date().toISOString().slice(0, 10)
  const prompt = `You are analyzing a phone call transcript between Ryan (a cash home buyer) and a real estate seller lead.

TODAY IS ${today}. All recommended_followup_date values must be on or after today.

Produce a JSON object with these fields:

- temperature: one of "hot" | "warm" | "cold"
    hot  = actively wants to sell now or within 1-2 months, motivated
    warm = interested, 3-6 month timeline, open to exploring
    cold = curious, no timeline, "maybe someday", or unclear / inconclusive
    (For an explicit "no / don't call me", still pick cold — Ryan controls
     the lifecycle dead status manually.)

- summary: a plain prose paragraph, 2 to 6 sentences. No headers, no bullets,
    no bold. Cover who the caller is, what their inquiry is about, any
    obvious next-step or urgency cue. Emojis allowed where natural, not
    required.

- name: the caller's stated name (best-effort, even if audio was unclear).
    Null only if the transcript contains no name reference at all.

- property_address: any property address the caller mentioned (best-effort,
    even partial). Null only if no address was mentioned.

- recommended_followup_date: ISO date YYYY-MM-DD >= today, or null if the
    caller said "don't call me".

- followup_reason: one short sentence on why that date.

Respond with ONLY the JSON object - no markdown fences, no explanation.

{
  "temperature": "...",
  "summary": "...",
  "name": "..." | null,
  "property_address": "..." | null,
  "recommended_followup_date": "YYYY-MM-DD" | null,
  "followup_reason": "..." | null
}

TRANSCRIPT:
"${transcript}"`

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  })
  if (!res.ok) {
    console.error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return null
  }
  const json = await res.json()
  const content = json.choices?.[0]?.message?.content?.trim() || ""
  const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
  try {
    const parsed = JSON.parse(cleaned)
    if (!parsed.temperature || !VALID_TEMPS.includes(parsed.temperature)) return null
    if (!parsed.summary || typeof parsed.summary !== "string") return null
    return {
      temperature: parsed.temperature,
      summary: parsed.summary.trim(),
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null,
      property_address:
        typeof parsed.property_address === "string" && parsed.property_address.trim()
          ? parsed.property_address.trim()
          : null,
      recommended_followup_date:
        typeof parsed.recommended_followup_date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.recommended_followup_date)
          ? parsed.recommended_followup_date
          : null,
      followup_reason:
        typeof parsed.followup_reason === "string" && parsed.followup_reason.trim()
          ? parsed.followup_reason.trim()
          : null,
    }
  } catch (e) {
    console.error(`parse failed: ${cleaned.slice(0, 200)}`)
    return null
  }
}

async function applyResult(lead, result) {
  const update = {
    temperature: result.temperature,
    ai_summary: result.summary,
    ai_summary_generated_at: new Date().toISOString(),
    recommended_followup_date: result.recommended_followup_date ?? defaultFollowupDate(),
    followup_reason: result.followup_reason ?? DEFAULT_FOLLOWUP_REASON,
    followup_generated_at: new Date().toISOString(),
    suggested_status: null,
    suggested_status_reason: null,
  }
  if (result.name && !lead.name) update.name = result.name
  if (result.property_address && !lead.property_address) update.property_address = result.property_address

  if (dryRun) {
    console.log(`  [dry-run] would update ${lead.id}:`)
    console.log(JSON.stringify(update, null, 2))
    return
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${lead.id}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(update),
  })
  if (!res.ok) {
    console.error(`  PATCH ${lead.id} failed ${res.status}: ${await res.text()}`)
    return
  }
  console.log(`  ✓ ${lead.id} → temp=${result.temperature} followup=${update.recommended_followup_date}`)
}

async function fetchLeads() {
  if (idArg) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${idArg}&select=id,name,property_address,message,lead_type,caller_phone`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    return await res.json()
  }
  // --all: rows with a transcript message and missing temperature
  const q = new URLSearchParams({
    select: "id,name,property_address,message,lead_type,caller_phone",
    temperature: "is.null",
    lead_type: "in.(call,voicemail)",
    message: "not.is.null",
    limit: "200",
  })
  const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?${q}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  return await res.json()
}

const leads = await fetchLeads()
console.log(`Found ${leads.length} lead(s) to process${dryRun ? " (dry-run)" : ""}.`)
for (const lead of leads) {
  if (!lead.message || lead.message.length < 20) {
    console.log(`  ⊘ ${lead.id} skipped (no/short transcript)`)
    continue
  }
  console.log(`→ ${lead.id} (${lead.caller_phone}, ${lead.lead_type})`)
  const result = await analyze(lead.message)
  if (!result) {
    console.log(`  ✗ analyze failed`)
    continue
  }
  await applyResult(lead, result)
}
console.log("Done.")
