#!/usr/bin/env node
// One-off (2026-05-14): re-run the reworked analyzer over the call/voicemail
// backlog so the new engagement-based temperature rubric + transcript-reasoned
// follow-up + email extraction land on existing leads.
//
// Two passes:
//   --reanalyze : every call/voicemail lead with a transcript (>=15 chars) →
//                 POST /api/leads/<id>/analyze-call { silent:true }. This goes
//                 through lib/leads.ts (single source of truth — no prompt
//                 duplication, no drift). `silent` suppresses the per-lead
//                 Telegram alert so 80+ rows don't spam the channel.
//   --sweep     : call/voicemail leads with NO transcript + NO recording +
//                 NO temperature → stamp the cold no-signal default
//                 (mirrors applyColdNoSignalDefault in lib/leads.ts).
//   --all       : both.
//
// Dry-run by default. Add --apply to write.
// Needs a dev server with the reworked code + an auth cookie:
//   REANALYZE_PORT=3009 node scripts/reanalyze-leads-2026-05-14.mjs --all --apply
// Cookie: /tmp/drips-cookies.txt (same as drips-e2e-test.mjs).

import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

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
const APPLY = args.includes("--apply")
const doReanalyze = args.includes("--reanalyze") || args.includes("--all")
const doSweep = args.includes("--sweep") || args.includes("--all")
if (!doReanalyze && !doSweep) {
  console.error("Usage: reanalyze-leads-2026-05-14.mjs (--reanalyze | --sweep | --all) [--apply]")
  process.exit(2)
}

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)
const BASE = `http://localhost:${process.env.REANALYZE_PORT || 3001}`
const COOKIE = "/tmp/drips-cookies.txt"
console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}   server: ${BASE}`)

function post(path, body) {
  const out = execFileSync("curl", [
    "-sS", "-b", COOKIE, "-X", "POST", `${BASE}${path}`,
    "-H", "Content-Type: application/json", "-d", JSON.stringify(body),
    "--max-time", "60",
  ], { encoding: "utf8" })
  try { return JSON.parse(out) } catch { return { error: out.slice(0, 200) } }
}

// ── Pass 1: re-analyze transcript leads ─────────────────────────────────────
if (doReanalyze) {
  const { data: leads, error } = await sb
    .from("leads")
    .select("id, caller_phone, lead_type, message, temperature, followup_generated_at")
    .in("lead_type", ["call", "voicemail"])
    .not("message", "is", null)
    .limit(2000)
  if (error) { console.error("query failed:", error.message); process.exit(1) }
  // Idempotent re-runs: skip leads already re-analyzed today. analyzeCallTranscript
  // stamps followup_generated_at (the summary route does NOT), so a value dated
  // today means this script already hit that row this session — lets a re-run
  // after an OpenRouter top-up pick up only the rows that didn't finish.
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const targets = (leads ?? []).filter(l => {
    if ((l.message || "").trim().length < 15) return false
    if (l.followup_generated_at && new Date(l.followup_generated_at) >= todayStart) return false
    return true
  })
  const alreadyDone = (leads ?? []).filter(l =>
    (l.message || "").trim().length >= 15 &&
    l.followup_generated_at && new Date(l.followup_generated_at) >= todayStart
  ).length
  console.log(`\n[reanalyze] ${targets.length} call/voicemail leads with a transcript to process` +
    (alreadyDone ? ` (${alreadyDone} already done today — skipping)` : ""))
  let ok = 0, fail = 0
  for (const l of targets) {
    if (!APPLY) { console.log(`  [dry] would re-analyze ${l.id} (${l.caller_phone}, temp=${l.temperature ?? "null"})`); continue }
    const res = post(`/api/leads/${l.id}/analyze-call`, { silent: true })
    if (res.error) { console.error(`  ✗ ${l.id}: ${res.error}`); fail++ }
    else { console.log(`  ✓ ${l.id} → ${res.temperature} | followup=${res.recommended_followup_date ?? "none"} | email=${res.email ?? "—"}`); ok++ }
  }
  console.log(`[reanalyze] done — ${ok} ok, ${fail} failed${APPLY ? "" : " (dry-run)"}`)
}

// ── Pass 2: cold no-signal sweep ────────────────────────────────────────────
if (doSweep) {
  const { data: leads, error } = await sb
    .from("leads")
    .select("id, caller_phone, lead_type, message, recording_url, temperature, recommended_followup_date, ai_summary")
    .in("lead_type", ["call", "voicemail"])
    .is("recording_url", null)
    .is("temperature", null)
    .limit(2000)
  if (error) { console.error("sweep query failed:", error.message); process.exit(1) }
  const targets = (leads ?? []).filter(l => (l.message || "").trim().length < 15)
  console.log(`\n[sweep] ${targets.length} no-signal call/voicemail leads (no transcript, no recording, no temp)`)
  let ok = 0, fail = 0
  for (const l of targets) {
    const update = { temperature: "cold" }
    if (!l.recommended_followup_date) {
      const d = new Date()
      d.setDate(d.getDate() + 180)
      update.recommended_followup_date = d.toISOString().slice(0, 10)
      update.followup_reason = "Called but left no message — cold, routine 6-month nurture check-in."
      update.followup_generated_at = new Date().toISOString()
    }
    if (!l.ai_summary) {
      update.ai_summary = "Caller reached voicemail but didn't leave a message — no details to go on yet. Kept on the nurture drip with a 6-month check-in."
      update.ai_summary_generated_at = new Date().toISOString()
    }
    if (!APPLY) { console.log(`  [dry] would stamp cold ${l.id} (${l.caller_phone})`); continue }
    const { error: upErr } = await sb.from("leads").update(update).eq("id", l.id)
    if (upErr) { console.error(`  ✗ ${l.id}: ${upErr.message}`); fail++ }
    else { console.log(`  ✓ ${l.id} → cold + 6mo follow-up`); ok++ }
  }
  console.log(`[sweep] done — ${ok} ok, ${fail} failed${APPLY ? "" : " (dry-run)"}`)
}

console.log("\nDone.")
