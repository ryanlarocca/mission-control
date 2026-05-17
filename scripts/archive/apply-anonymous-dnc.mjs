#!/usr/bin/env node
// Anonymous cluster has no phone/email — apply DNC by lead_id directly.

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

const ids = [
  "07393197-6c07-420a-a00a-8a5d130f0a0a",
  "fd969d9f-12f7-4452-8dcb-c91efac2fc0d",
  "ddbc54b3-42e7-48de-8530-4bc967800e9d",
  "6e841dc0-f7fb-469b-9e4e-7d7f0e06461d",
  "5b36419d-5eba-492f-bcfe-27125bdedc9d",
  "cf1c86a1-b2bc-43fc-ad37-8a5444badc19",
  "f08e84ef-9b6b-4d62-b87a-a3170c27474f",
  "b64cda5b-7d73-4646-917c-d38cccdffbdd",
]
const REP_ID = "ddbc54b3-42e7-48de-8530-4bc967800e9d" // voicemail row w/ followup_reason

const { error: updErr } = await sb.from("leads").update({ is_dnc: true, status: "dead" }).in("id", ids)
if (updErr) { console.error("update failed:", updErr.message); process.exit(1) }

const { data: rep } = await sb.from("leads").select("name, property_address").eq("id", REP_ID).single()
const { error: dncErr } = await sb.from("dnc_list").insert({
  site_address: rep?.property_address || null,
  owner_name: rep?.name || null,
  source_lead_id: REP_ID,
  reason: "hostile",
  added_by: "ryan",
})
if (dncErr) console.warn("dnc_list insert warning:", dncErr.message)
else console.log("dnc_list +1")

console.log(`✓ Anonymous cluster: ${ids.length} rows → is_dnc=true status=dead [hostile]`)
