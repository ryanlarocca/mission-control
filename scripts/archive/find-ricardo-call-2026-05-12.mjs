#!/usr/bin/env node
// One-off: find Ricardo's orphaned call row. Searches two ways:
//   (a) Any row in the leads table whose name/ai_summary/ai_notes mentions
//       "ricardo" (case-insensitive) — catches the case where an earlier
//       row in his cluster already has the name from a prior interaction.
//   (b) All recent call/voicemail rows with recording_url IS NULL — these
//       are the orphan candidates regardless of name.
// Cross-reference: if a name match exists for a phone that ALSO appears in
// the orphan list, that's our most likely Ricardo.

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

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)

const hr = "─".repeat(78)
console.log(hr); console.log("ROWS MENTIONING 'RICARDO' (name / ai_summary / ai_notes)"); console.log(hr)
const { data: nameHits, error: nameErr } = await sb
  .from("leads")
  .select("id, created_at, caller_phone, name, lead_type, status, recording_url, ai_summary")
  .or("name.ilike.%ricardo%,ai_summary.ilike.%ricardo%,ai_notes.ilike.%ricardo%")
  .order("created_at", { ascending: false })
  .limit(20)
if (nameErr) { console.error("name search failed:", nameErr.message); process.exit(1) }
if (!nameHits || nameHits.length === 0) {
  console.log("  (no rows with 'ricardo' in name/summary/notes)")
} else {
  for (const r of nameHits) {
    const rec = r.recording_url ? "✓rec" : "✗no-rec"
    console.log(`  ${r.created_at}  ${r.lead_type.padEnd(10)} ${(r.name||"(no name)").padEnd(20)} ${(r.caller_phone||"—").padEnd(15)} status=${r.status} ${rec}  id=${r.id}`)
  }
}

console.log("")
console.log(hr); console.log("ORPHANED CALL/VM ROWS (last 24h, recording_url IS NULL)"); console.log(hr)
const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
const { data: orphans, error: orphanErr } = await sb
  .from("leads")
  .select("id, created_at, caller_phone, twilio_number, name, lead_type, status")
  .is("recording_url", null)
  .in("lead_type", ["call", "voicemail"])
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(30)
if (orphanErr) { console.error("orphan search failed:", orphanErr.message); process.exit(1) }
if (!orphans || orphans.length === 0) {
  console.log("  (none — every recent call row has a recording attached)")
} else {
  for (const r of orphans) {
    console.log(`  ${r.created_at}  ${r.lead_type.padEnd(10)} ${(r.name||"(no name)").padEnd(20)} ${(r.caller_phone||"—").padEnd(15)} → ${r.twilio_number||"—"}  status=${r.status}  id=${r.id}`)
  }
}
