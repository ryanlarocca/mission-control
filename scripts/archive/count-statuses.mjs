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

const res = await fetch(`${url}/rest/v1/leads?select=status,temperature&limit=2000`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
})
if (!res.ok) {
  console.error("HTTP", res.status, await res.text())
  process.exit(1)
}
const rows = await res.json()
const status = {}
const temp = {}
for (const r of rows) {
  status[r.status] = (status[r.status] || 0) + 1
  temp[r.temperature ?? "NULL"] = (temp[r.temperature ?? "NULL"] || 0) + 1
}
console.log(`Total rows: ${rows.length}`)
console.log("\nstatus counts:")
for (const [k, v] of Object.entries(status).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
console.log("\ntemperature counts:")
for (const [k, v] of Object.entries(temp).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
