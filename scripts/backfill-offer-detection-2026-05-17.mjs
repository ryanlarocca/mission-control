#!/usr/bin/env node
// One-shot backfill: detect verbalized offers in historical leads and stamp
// offer_amount + offer_verbalized_at on the row. Hands-off — only writes
// when those columns are currently null. Timestamp is the lead row's
// created_at (the real event date), not now().
//
// Pipeline:
//   1. Pull every lead with a transcript (message OR ai_notes) and no
//      offer_amount yet.
//   2. Pre-filter via regex — dollar amount + a "Ryan said it" cue
//      phrase. Skips ~99% of rows without an LLM call.
//   3. For each candidate, send the transcript to Haiku with the
//      offer-detection-only prompt (same rules as analyzeCallTranscript's
//      offer block — Ryan's price to the seller, not the seller's asking
//      price).
//   4. On offer_verbalized=true with a positive amount, write back to
//      Supabase using the lead's created_at as offer_verbalized_at.
//
// Cost: at ~17 candidates per the pre-filter scan, this is 17 Haiku calls.
// Each is well under 4k input tokens + 50 output tokens.
//
// Usage:
//   node scripts/backfill-offer-detection-2026-05-17.mjs --dry-run
//   node scripts/backfill-offer-detection-2026-05-17.mjs            # apply
//   node scripts/backfill-offer-detection-2026-05-17.mjs --lead <uuid>  # one row

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

const DRY = process.argv.includes("--dry-run")
const leadFilterArg = process.argv.indexOf("--lead")
const LEAD_FILTER_ID = leadFilterArg >= 0 ? process.argv[leadFilterArg + 1] : null
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY
if (!OPENROUTER_KEY) { console.error("OPENROUTER_API_KEY not set"); process.exit(1) }

// ── Regex pre-filter (same as scan script) ──────────────────────────────
const MONEY_RE = /\$\s*[\d,]+(?:\.\d+)?\s*[kKmM]?|\b\d+(?:\.\d+)?\s*(?:million|thousand|[kKmM])\b|\b\d{3},\d{3}\b/
const RYAN_CUES = [
  /\b(?:can|could|would)\s+(?:do|offer|go|come\s+up\s+to|come\s+down\s+to|stretch\s+to)\b/i,
  /\bwhat\s+about\s+\$/i,
  /\bI'?ll\s+offer\b/i,
  /\bI'?d\s+(?:offer|do|go|consider)\b/i,
  /\bmy\s+(?:offer|number|price)\b/i,
  /\bwe(?:'re)?\s+(?:typically|usually)\s+(?:in|at|around)\b/i,
  /\b(?:offer|price)\s+(?:of|around|at)\b/i,
  /\bcash\s+(?:offer|of|at)\b/i,
  /\b(?:offered|offering)\s+(?:them|him|her)?\s*\$/i,
  /\bin\s+the\s+\$[\d,]+\s*[kKmM]?\s*(?:range|ballpark)\b/i,
]
function passesPreFilter(text) {
  return MONEY_RE.test(text) && RYAN_CUES.some(re => re.test(text))
}

// ── Haiku offer-detection prompt ───────────────────────────────────────
// Tighter than the in-product analyzer because we don't need temperature /
// summary / follow-up here — just the offer signal.
function buildPrompt(transcript) {
  return `You are reading a conversation between Ryan (a cash home buyer / investor in the Bay Area) and a real estate seller lead. Your ONLY job is to decide whether Ryan VERBALIZED a specific purchase-price offer to the seller in this conversation, and if so, capture the amount.

CRITICAL: this is RYAN'S price TO the seller. NOT the seller's asking price. NOT the seller's stated rent on their property. NOT a hypothetical market example. NOT Ryan teaching cap-rate math.

Return JSON only:
{
  "offer_amount": number | null,
  "offer_verbalized": true | false,
  "evidence": "<the exact quote from Ryan that contains the offer, or null>"
}

RULES:
- offer_verbalized=true ONLY when Ryan states a specific dollar amount as what HE would pay / offer / do for THIS seller's property in THIS conversation.
- Soft / conditional offers count: "I could probably do around $700K if it checks out" → offer_amount: 700000.
- Ranges → take the midpoint, round to the nearest 1k: "$700-750K" → 725000.
- A reference to a PAST offer ("I offered you $1.6m a while back") DOES count — it's still Ryan stating a number to this seller.
- Direct mail letter contents don't count (those are mailer marketing, not verbalized).
- The seller stating an asking price ("I want $850K") does NOT count, even if Ryan acknowledges it.
- Ryan stating rents he gets on his OWN properties does NOT count.
- Ryan explaining a generic formula ("at 10% cap, you'd offer $250K") does NOT count unless he applies the number to THIS seller's property.
- Hypothetical market examples ("Menlo Park comps are $3.5-4M, off-market $2.5M") do NOT count.
- When in doubt, return false. False positives lose campaign-performance signal; false negatives can be fixed with the pencil edit.

CONVERSATION TRANSCRIPT:
"""
${transcript}
"""

Respond with ONLY the JSON object.`
}

async function detectOffer(transcript) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      max_tokens: 200,
      messages: [{ role: "user", content: buildPrompt(transcript) }],
    }),
  })
  if (!res.ok) {
    console.error(`  Haiku ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return null
  }
  const j = await res.json()
  const content = j.choices?.[0]?.message?.content?.trim() || ""
  const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.error(`  Parse failed: ${content.slice(0, 200)}`)
    return null
  }
}

// ── main ────────────────────────────────────────────────────────────────
let query = sb
  .from("leads")
  .select("id, name, caller_phone, created_at, message, ai_notes, offer_amount, lead_type, source")
  .or("message.not.is.null,ai_notes.not.is.null")
  .is("offer_amount", null)
  .order("created_at", { ascending: false })
  .limit(2000)
if (LEAD_FILTER_ID) query = query.eq("id", LEAD_FILTER_ID)
const { data: leads, error } = await query
if (error) { console.error(error); process.exit(1) }

const candidates = leads.filter(l => {
  const text = [l.message || "", l.ai_notes || ""].join("\n").trim()
  return text && passesPreFilter(text)
})
console.log(`Scanning ${leads.length} leads (no existing offer)`)
console.log(`Pre-filter → ${candidates.length} candidates to send to Haiku\n`)

const findings = []
let i = 0
for (const lead of candidates) {
  i++
  const text = [lead.message || "", lead.ai_notes || ""].join("\n").trim()
  // Most transcripts are < 10k chars. Truncate the rest to keep input small.
  const transcript = text.length > 12000 ? text.slice(0, 12000) + "…[truncated]" : text
  process.stdout.write(`  [${i}/${candidates.length}] ${lead.id.slice(0,8)} ${(lead.name || "—").padEnd(20)} … `)
  const result = await detectOffer(transcript)
  if (!result) { console.log("ERROR"); continue }
  if (result.offer_verbalized && typeof result.offer_amount === "number" && result.offer_amount > 0) {
    console.log(`✓ $${result.offer_amount.toLocaleString()}`)
    findings.push({ lead, amount: result.offer_amount, evidence: result.evidence })
  } else {
    console.log("—")
  }
}

console.log(`\nDetected ${findings.length} verbalized offers across ${candidates.length} candidates`)
for (const f of findings) {
  console.log(`\n  ${f.lead.id.slice(0,8)} | ${f.lead.name || "—"} | ${f.lead.created_at.slice(0, 10)} | $${f.amount.toLocaleString()}`)
  if (f.evidence) console.log(`    "${f.evidence}"`)
}

if (DRY || findings.length === 0) {
  console.log(DRY ? "\nDry run — no writes." : "\nNothing to write.")
  process.exit(0)
}

console.log(`\nWriting ${findings.length} offer events…`)
for (const f of findings) {
  // Hands-off — re-check that offer_amount is still null (the row could have
  // been edited between the read above and now). Use the lead's created_at
  // as the verbalized timestamp so the funnel attributes the offer to the
  // correct historical date.
  const { data: cur } = await sb
    .from("leads")
    .select("offer_amount, offer_verbalized_at, created_at")
    .eq("id", f.lead.id)
    .single()
  if (cur?.offer_amount != null) {
    console.log(`  skip ${f.lead.id.slice(0,8)} — already has offer $${cur.offer_amount}`)
    continue
  }
  const stamp = cur?.created_at || f.lead.created_at
  const { error: upErr } = await sb
    .from("leads")
    .update({ offer_amount: f.amount, offer_verbalized_at: stamp })
    .eq("id", f.lead.id)
  if (upErr) console.error(`  fail ${f.lead.id.slice(0,8)}: ${upErr.message}`)
  else console.log(`  ✓ ${f.lead.id.slice(0,8)} ← $${f.amount.toLocaleString()} @ ${stamp.slice(0,10)}`)
}

console.log("\nDone.")
