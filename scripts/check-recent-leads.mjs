import fs from "node:fs"

const envPath = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control/.env.local"
const env = {}
for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  env[m[1]] = v
}

const url = env.LRG_SUPABASE_URL
const key = env.LRG_SUPABASE_SERVICE_KEY
const sinceMin = parseInt(process.argv[2] || "15", 10)
const since = new Date(Date.now() - sinceMin * 60 * 1000).toISOString()

const q = new URLSearchParams({
  select:
    "id,created_at,source,twilio_number,caller_phone,lead_type,status,drip_campaign_type,recording_url,message,ai_notes",
  created_at: `gte.${since}`,
  order: "created_at.desc",
  limit: "20",
})

const res = await fetch(`${url}/rest/v1/leads?${q}`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
})
if (!res.ok) {
  console.error("HTTP", res.status, await res.text())
  process.exit(1)
}
const rows = await res.json()
console.log(`Found ${rows.length} rows in last ${sinceMin} min:\n`)
for (const r of rows) {
  console.log(
    `${r.created_at} | source=${r.source} | twilio=${r.twilio_number ?? "NULL(outbound)"} | caller=${r.caller_phone} | type=${r.lead_type} | status=${r.status} | drip=${r.drip_campaign_type ?? "NULL"} | rec=${r.recording_url ? "yes" : "no"}`
  )
  if (r.message) console.log(`  msg: ${r.message.slice(0, 100)}`)
  if (r.ai_notes) console.log(`  ai:  ${r.ai_notes.slice(0, 100)}`)
}
