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
const phone = process.argv[2]
if (!phone) {
  console.error("Usage: node scripts/check-leads-by-phone.mjs <E164_PHONE> [minutes]")
  process.exit(1)
}
const sinceMin = parseInt(process.argv[3] || "30", 10)
const since = new Date(Date.now() - sinceMin * 60 * 1000).toISOString()

const q = new URLSearchParams({
  select:
    "id,created_at,source,twilio_number,caller_phone,lead_type,status,drip_campaign_type,drip_touch_number,message,ai_notes,recording_url",
  caller_phone: `eq.${phone}`,
  created_at: `gte.${since}`,
  order: "created_at.desc",
  limit: "10",
})

const res = await fetch(`${url}/rest/v1/leads?${q}`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
})
if (!res.ok) {
  console.error("HTTP", res.status, await res.text())
  process.exit(1)
}
const rows = await res.json()
console.log(`Found ${rows.length} rows for ${phone} in last ${sinceMin} min:\n`)
for (const r of rows) {
  const msg = r.message ? r.message.slice(0, 80) : ""
  const ai = r.ai_notes ? r.ai_notes.slice(0, 80) : ""
  console.log(
    [
      `id=${r.id}`,
      `created=${r.created_at}`,
      `source=${r.source}`,
      `twilio_number=${r.twilio_number}`,
      `lead_type=${r.lead_type}`,
      `status=${r.status}`,
      `drip=${r.drip_campaign_type ?? "NULL"} touch=${r.drip_touch_number ?? "NULL"}`,
      `has_recording=${r.recording_url ? "yes" : "no"}`,
      msg ? `\n  message="${msg}${r.message.length > 80 ? "…" : ""}"` : "",
      ai ? `\n  ai_notes="${ai}${r.ai_notes.length > 80 ? "…" : ""}"` : "",
    ]
      .filter(Boolean)
      .join("\n  ")
  )
  console.log("---")
}
