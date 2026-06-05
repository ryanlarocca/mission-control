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
const H = { apikey: key, Authorization: `Bearer ${key}` }

const hours = parseInt(process.argv[2] || "24", 10)
const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()

async function q(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: { ...H, Prefer: "count=exact" } })
  if (!res.ok) { console.error("HTTP", res.status, await res.text()); process.exit(1) }
  return { rows: await res.json(), count: res.headers.get("content-range") }
}

console.log(`\n=== DRIP / SMS ACTIVITY (last ${hours}h, since ${since}) ===\n`)

// 1. drip_queue by status, created since window
const dq = await q(
  `drip_queue?select=id,lead_id,status,channel,sent_at,created_at,error,message,campaign_type,touch_number&created_at=gte.${since}&order=created_at.desc&limit=500`
)
const byStatus = {}
for (const r of dq.rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1
console.log("drip_queue rows created in window:", dq.rows.length)
console.log("  by status:", JSON.stringify(byStatus))

// 2. Anything SENT in window (regardless of when created)
const sent = await q(
  `drip_queue?select=id,lead_id,status,sent_at,message,channel,campaign_type&status=eq.sent&sent_at=gte.${since}&order=sent_at.desc&limit=500`
)
console.log("\ndrip_queue SENT in window:", sent.rows.length)
for (const r of sent.rows.slice(0, 40)) {
  console.log(`  ✓ ${r.sent_at}  [${r.channel || "?"}/${r.campaign_type||""}]  lead=${r.lead_id}  ${(r.message || "").slice(0, 55).replace(/\n/g, " ")}`)
}

// 3. Still pending / approved (queued but NOT sent)
const pending = await q(
  `drip_queue?select=id,lead_id,status,created_at,snoozed_until,message,channel&status=in.(approved,pending,queued)&order=created_at.desc&limit=200`
)
console.log("\ndrip_queue NOT yet sent (approved/pending/queued):", pending.rows.length)
for (const r of pending.rows.slice(0, 30)) {
  console.log(`  ⏳ ${r.status}  created=${r.created_at}  lead=${r.lead_id}  ${(r.message || "").slice(0, 45).replace(/\n/g, " ")}`)
}

// 4. Failed sends
const failed = await q(
  `drip_queue?select=id,lead_id,status,error,created_at,message&status=in.(failed,dead)&created_at=gte.${since}&order=created_at.desc&limit=100`
)
console.log("\ndrip_queue FAILED/DEAD in window:", failed.rows.length)
for (const r of failed.rows) {
  console.log(`  ✗ ${r.status}  ${r.error}  lead=${r.lead_id}  ${(r.message || "").slice(0, 40).replace(/\n/g, " ")}`)
}

// 5. Inbound REPLIES only. Convention: outbound rows have twilio_number IS NULL;
//    a genuine inbound reply has twilio_number NOT NULL (the LRG number it hit).
console.log(`\n=== INBOUND REPLIES (last ${hours}h — twilio_number NOT NULL) ===\n`)
const inbound = await q(
  `leads?select=id,created_at,caller_phone,twilio_number,lead_type,source,status,is_dnc,message,name&created_at=gte.${since}&lead_type=in.(sms,email)&twilio_number=not.is.null&order=created_at.desc&limit=100`
)
console.log("Genuine inbound replies in window:", inbound.rows.length)
for (const r of inbound.rows) {
  const who = r.name ? `${r.name} (${r.caller_phone})` : r.caller_phone
  const flag = r.is_dnc ? " 🚫DNC" : ""
  console.log(`  📩 ${r.created_at}  ${r.lead_type}  ${who} → ${r.twilio_number}  [${r.status}]${flag}  ${(r.message || "").slice(0, 70).replace(/\n/g, " ")}`)
}

// For reference: outbound rows logged to leads (twilio_number IS NULL) — these
// are SENDS, not replies. Counts only, so we don't confuse them with responses.
const outboundLogged = await q(
  `leads?select=id&created_at=gte.${since}&lead_type=in.(sms,email,drip_imessage)&twilio_number=is.null&limit=500`
)
console.log(`\n(for ref) outbound msgs logged to leads in window: ${outboundLogged.rows.length}`)
console.log()
