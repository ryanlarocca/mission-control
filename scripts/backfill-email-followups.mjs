#!/usr/bin/env node
// One-time catch-up for BRIEF_LEAD_RECOVERY_2026-09-02 Phase 1.
//
// Until 2026-09-02 the email intake path never wrote recommended_followup_date
// or followup_reason, so every inbound email lead was invisible to
// /api/follow-ups (it selects on `drip_campaign_type NOT NULL OR
// recommended_followup_date NOT NULL`). Chris Shoemaker wrote "Give me a call
// if you'd like to discuss timing and pricing" and produced no task at all.
//
// triageEmailLead now sets both on intake. This script walks the history that
// missed it. It is deliberately NOT a copy of triageEmailLead — it asks one
// narrow question (does this message justify a follow-up date?) so there is
// nothing to drift out of sync. Nothing else on the row is touched.
//
//   node scripts/backfill-email-followups.mjs            # dry run
//   node scripts/backfill-email-followups.mjs --write
//   node scripts/backfill-email-followups.mjs --id <uuid> --write
import fs from "node:fs"
import path from "node:path"

const envPath = [
  path.join(process.cwd(), ".env.local"),
  "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local",
].find((p) => fs.existsSync(p))
const env = {}
for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "")
}
const SB = env.LRG_SUPABASE_URL
const H = {
  apikey: env.LRG_SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.LRG_SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
}
const args = process.argv.slice(2)
const WRITE = args.includes("--write")
const ONE = args[args.indexOf("--id") + 1] && args.includes("--id") ? args[args.indexOf("--id") + 1] : null
const TODAY = new Date().toISOString().slice(0, 10)

async function extract(subject, body) {
  const prompt = `A property owner replied to a real estate direct-mail campaign. Decide whether Ryan owes them a follow-up, and when.

TODAY IS ${TODAY}.

Message:
${subject ? `Subject: ${subject}\n` : ""}${body}

Respond with ONLY JSON:
{ "recommended_followup_date": "YYYY-MM-DD" | null, "followup_reason": "short phrase quoting the sender" | null }

Set a date whenever the sender invites contact or names a timeframe:
  • an explicit invitation — "give me a call", "call me at ...", "let me know",
    "please contact me", "what's your offer?"
  • a stated timeline — "not until spring", "check back in 60 days"
  • an open question aimed at Ryan that he still owes an answer to
Resolve relative wording against TODAY. A bare invitation with no timing → tomorrow.
followup_reason quotes the sender in their own words — Ryan reads it in his worklist.

Both null when the sender declined, opted out, is hostile, or gave nothing to
act on. Never invent a date to look useful. If you set one field, set both.`

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-haiku-4-5", messages: [{ role: "user", content: prompt }], max_tokens: 300 }),
  })
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  const raw = (j.choices?.[0]?.message?.content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "")
  // Haiku sometimes appends a sentence of commentary after the object, which
  // makes a bare JSON.parse throw. Take the first {...} block instead.
  const block = raw.match(/\{[\s\S]*?\}/)
  if (!block) throw new Error(`no JSON object in response: ${raw.slice(0, 120)}`)
  const p = JSON.parse(block[0])
  const date = typeof p.recommended_followup_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.recommended_followup_date.trim())
    ? p.recommended_followup_date.trim() : null
  const reason = typeof p.followup_reason === "string" && p.followup_reason.trim() ? p.followup_reason.trim() : null
  // Same pairing rule the intake path enforces — a date without a reason is
  // unusable in the worklist, and a reason without a date schedules nothing.
  return date && reason ? { date, reason } : { date: null, reason: null }
}

let leads = []
for (let o = 0; ; o += 1000) {
  const r = await fetch(`${SB}/rest/v1/leads?select=id,created_at,name,email,message,lead_type,twilio_number,status,is_dnc,is_junk,recommended_followup_date&lead_type=eq.email&order=created_at.asc`, { headers: { ...H, Range: `${o}-${o + 999}` } })
  const j = await r.json()
  leads.push(...j)
  if (j.length < 1000) break
}

const candidates = leads.filter((l) => {
  if (ONE) return l.id === ONE
  if (l.recommended_followup_date) return false      // already has one
  if (l.is_dnc || l.is_junk || l.status === "dead") return false
  if (!l.twilio_number) return false                  // outbound (isOutbound === !twilio_number)
  return (l.message || "").trim().length > 20
})

console.log(`${leads.length} email lead rows → ${candidates.length} candidates without a follow-up date`)
console.log(`${WRITE ? "WRITING" : "DRY RUN — pass --write to apply"}\n`)

let set = 0, none = 0, failed = 0
for (const l of candidates) {
  const subject = (l.message || "").startsWith("Subject:") ? "" : ""
  let out
  try {
    out = await extract(subject, (l.message || "").slice(0, 4000))
  } catch (e) {
    console.log(`  ✗ ${l.id.slice(0, 8)} ${(l.name || l.email || "?").slice(0, 24)} — ${e.message.slice(0, 70)}`)
    failed++
    continue
  }
  if (!out.date) {
    none++
    continue
  }
  const who = (l.name || l.email || l.id.slice(0, 8)).slice(0, 26)
  if (!WRITE) {
    console.log(`  + ${who.padEnd(28)} ${out.date}  "${out.reason.slice(0, 70)}"`)
    set++
    continue
  }
  const res = await fetch(`${SB}/rest/v1/leads?id=eq.${l.id}`, {
    method: "PATCH",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({
      recommended_followup_date: out.date,
      followup_reason: out.reason,
      followup_generated_at: new Date().toISOString(),
    }),
  })
  if (!res.ok) { console.log(`  ✗ PATCH ${l.id.slice(0, 8)} → ${res.status} ${await res.text()}`); failed++; continue }
  console.log(`  + ${who.padEnd(28)} ${out.date}  "${out.reason.slice(0, 70)}"`)
  set++
}

console.log(`\n${WRITE ? "done" : "dry run"}: ${set} with a follow-up, ${none} correctly left null, ${failed} failed`)
