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
const sinceMin = parseInt(process.argv[2] || "10", 10)
const since = new Date(Date.now() - sinceMin * 60 * 1000).toISOString()

const q = new URLSearchParams({
  select: "id,created_at,lead_type,source_type,source,name,email,caller_phone,message,ai_notes,suggested_reply,status",
  lead_type: "eq.email",
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
console.log(`Found ${rows.length} email lead(s) in last ${sinceMin}min:\n`)
for (const r of rows) {
  console.log("─".repeat(60))
  console.log(`id            ${r.id}`)
  console.log(`created_at    ${r.created_at}`)
  console.log(`source        ${r.source}`)
  console.log(`source_type   ${r.source_type}`)
  console.log(`name          ${r.name}`)
  console.log(`email         ${r.email}`)
  console.log(`caller_phone  ${r.caller_phone}`)
  console.log(`status        ${r.status}`)
  console.log(`ai_notes      ${(r.ai_notes || "").slice(0, 200)}`)
  console.log(`suggested_re. ${(r.suggested_reply || "").slice(0, 200)}`)
  console.log(`message       ${(r.message || "").slice(0, 200)}`)
}
