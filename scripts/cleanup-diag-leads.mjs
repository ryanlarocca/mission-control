// One-off: delete diagnostic sentinel rows from earlier debugging.
// Matches rows where source starts with "__diag" or name starts with "DIAG_".
import fs from "node:fs"

const env = {}
for (const line of fs.readFileSync("/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control/.env.local", "utf-8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue
  let v = m[2]; if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1)
  env[m[1]] = v
}
const url = env.LRG_SUPABASE_URL
const key = env.LRG_SUPABASE_SERVICE_KEY

const res = await fetch(`${url}/rest/v1/leads?source=like.__diag*`, {
  method: "DELETE",
  headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=representation" },
})
const body = await res.json()
console.log("deleted", Array.isArray(body) ? body.length : 0, "diag rows")
