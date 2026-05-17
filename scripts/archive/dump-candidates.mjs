#!/usr/bin/env node
// Dump full transcript text for a subset of clusters from audit-dnc-wide.json
// so we can eyeball each and bucket it DNC / Nurture / Keep-as-new.

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

const wantKeys = new Set([
  "+14082579008",          // Stuart
  "+14084103762",          // Yipei
  "+16699464411",          // Tan Nguyen
  "+14089313281",          // John
  "+16506786431",          // unnamed
  "+16507667727",          // Kiko Ohata
  "dennisconnally10@gmail.com",
  "terry_chandler2000@yahoo.com",
])

const json = JSON.parse(readFileSync(new URL("./audit-dnc-wide.json", import.meta.url), "utf8"))

for (const c of json.candidates) {
  if (!wantKeys.has(c.key)) continue
  console.log("\n" + "═".repeat(78))
  console.log(`KEY: ${c.key}   name=${c.name || "—"}   rules=${c.rules.join(", ")}`)
  console.log("═".repeat(78))
  const { data } = await sb
    .from("leads")
    .select("id, lead_type, status, is_dnc, is_junk, temperature, message, ai_notes, suggested_status_reason, followup_reason, created_at")
    .in("id", c.all_lead_ids)
    .order("created_at", { ascending: true })
  for (const r of data || []) {
    console.log(`\n[${r.created_at}] ${r.lead_type} status=${r.status} temp=${r.temperature || "—"} dnc=${r.is_dnc} junk=${r.is_junk}`)
    console.log(`id=${r.id}`)
    if (r.message)                  console.log(`MESSAGE:        ${r.message}`)
    if (r.ai_notes)                 console.log(`AI_NOTES:       ${r.ai_notes}`)
    if (r.suggested_status_reason)  console.log(`SUGGESTED:      ${r.suggested_status_reason}`)
    if (r.followup_reason)          console.log(`FOLLOWUP_REASON: ${r.followup_reason}`)
  }
}
