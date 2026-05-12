#!/usr/bin/env node
// Verify a list of rescued lead IDs actually have recording_url set on
// the original rows (vs. a new fallback voicemail row created elsewhere).
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
const ids = process.argv.slice(2)
if (ids.length === 0) { console.error("Usage: verify-rescues.mjs <id1> <id2> ..."); process.exit(1) }

const { data } = await sb.from("leads").select("id, caller_phone, lead_type, recording_url").in("id", ids)
const byId = new Map((data||[]).map(r => [r.id, r]))
let ok = 0, miss = 0
for (const id of ids) {
  const r = byId.get(id)
  if (!r) { console.log(`✗ ${id}  NOT FOUND`); miss++; continue }
  if (r.recording_url) {
    console.log(`✓ ${id}  ${r.lead_type.padEnd(10)} ${r.caller_phone}  rec=...${r.recording_url.slice(-40)}`)
    ok++
  } else {
    console.log(`✗ ${id}  ${r.lead_type.padEnd(10)} ${r.caller_phone}  STILL NO RECORDING_URL`)
    miss++
  }
}
console.log(`\n${ok}/${ids.length} have recording_url attached.`)
