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
const id = process.argv[2]
if (!id) {
  console.error("Usage: node scripts/check-lead-full.mjs <lead_id>")
  process.exit(1)
}

const res = await fetch(`${url}/rest/v1/leads?id=eq.${id}&select=*`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
})
if (!res.ok) {
  console.error("HTTP", res.status, await res.text())
  process.exit(1)
}
const rows = await res.json()
if (rows.length === 0) {
  console.error("No row")
  process.exit(1)
}
console.log(JSON.stringify(rows[0], null, 2))
