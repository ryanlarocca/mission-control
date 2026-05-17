#!/usr/bin/env node
// One-off: clear the T+24h "Initial follow-up after inbound call." default
// follow-up dates that pre-date this morning's prompt rewrite (May 12, 2026).
//
// Before today, applyAnalyzeCallResult / applyFollowupOnlyResult silently
// fell back to defaultFollowupDate() (T+1d) + DEFAULT_FOLLOWUP_REASON
// whenever the AI returned null. That populated the FollowUpTab queue with
// every inbound-call lead regardless of whether the transcript justified
// a follow-up. The fallback was removed in commit d3267ca; this script
// clears the existing rows so the queue reflects the new behavior.
//
// Target: exactly rows whose followup_reason equals the old default string.
// Real AI-justified rows have transcript-quoting reasons and won't match.
//
// Usage:
//   node scripts/clear-default-followup-dates-2026-05-12.mjs            # dry-run
//   node scripts/clear-default-followup-dates-2026-05-12.mjs --execute

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

const execute = process.argv.includes("--execute")
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)
const DEFAULT_REASON = "Initial follow-up after inbound call."

const { data: matches, error: cErr } = await sb
  .from("leads")
  .select("id, caller_phone, name, recommended_followup_date, followup_reason")
  .eq("followup_reason", DEFAULT_REASON)
if (cErr) { console.error("count failed:", cErr.message); process.exit(1) }

console.log(`${matches.length} row(s) carry the default reason.`)
for (const r of matches.slice(0, 10)) {
  console.log(`  ${r.recommended_followup_date}  ${(r.name||"(no name)").padEnd(20)} ${r.caller_phone||"—"}  id=${r.id}`)
}
if (matches.length > 10) console.log(`  …and ${matches.length - 10} more`)

if (!execute) {
  console.log("\nDry-run — re-run with --execute to clear.")
  process.exit(0)
}

const { error: uErr, count } = await sb
  .from("leads")
  .update({ recommended_followup_date: null, followup_reason: null }, { count: "exact" })
  .eq("followup_reason", DEFAULT_REASON)
if (uErr) { console.error("update failed:", uErr.message); process.exit(1) }
console.log(`\nCleared ${count ?? matches.length} row(s).`)
