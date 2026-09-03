#!/usr/bin/env node
// Phantom "leads" whose caller_phone is one of OUR OWN Twilio numbers.
//
// 2026-09-03: the landing page sends its "🔔 NEW LEAD" alert SMS from the
// Google Ads number to the Office — Info line. /api/leads/sms had no sender
// check and ingested that alert as an inbound lead. Clicking Call then dialed
// our own landing page — Ryan reached the LRG voicemail greeting, and the
// outbound leg logged three MORE phantom rows on the outbound caller-ID
// number, one of which got stamped drip_campaign_type=google_ads_form and was
// drip-eligible, i.e. queued to text our own line.
//
// The webhook guards (lib/leads.ts isOwnedNumber) stop new ones. This
// neutralizes the rows already written. Nothing is deleted — rows are marked
// is_junk + status=dead and have their drip stamp cleared, which is fully
// reversible and is exactly how the engine and the Follow Ups route are
// already taught to ignore a row.
//
//   node scripts/neutralize-self-leads.mjs                 # dry run, today's only
//   node scripts/neutralize-self-leads.mjs --write
//   node scripts/neutralize-self-leads.mjs --all [--write] # include the 2026 test rows
import fs from "node:fs"
import path from "node:path"

const envPath = [
  path.join(process.cwd(), ".env.local"),
  "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local",
].find((p) => fs.existsSync(p))
const env = {}
for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "")
}
const SB = env.LRG_SUPABASE_URL
const H = {
  apikey: env.LRG_SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.LRG_SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
}
const WRITE = process.argv.includes("--write")
const ALL = process.argv.includes("--all")
// Cutoff for the "live bug" set. Everything before this is Ryan's May/July
// build-out testing ("Testing, testing, 1-2-3", "Test44", "Michael Jackson"),
// which is historical noise rather than active harm — --all opts into it.
const LIVE_BUG_SINCE = "2026-09-01"

// Straight from the Twilio account, so a number added to the console but not
// yet to CAMPAIGN_MAP is still caught.
const auth = "Basic " + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")
const tw = await (await fetch(
  `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PageSize=100`,
  { headers: { Authorization: auth } }
)).json()
const owned = new Set((tw.incoming_phone_numbers || []).map((n) => n.phone_number))
if (owned.size === 0) { console.error("Twilio returned no numbers — refusing to run blind"); process.exit(1) }
console.log(`${owned.size} numbers on the Twilio account`)

let rows = []
for (let o = 0; ; o += 1000) {
  const j = await (await fetch(`${SB}/rest/v1/leads?select=id,created_at,caller_phone,lead_type,name,status,is_junk,drip_campaign_type,message&order=created_at.asc`, { headers: { ...H, Range: `${o}-${o + 999}` } })).json()
  rows.push(...j)
  if (j.length < 1000) break
}
const all = rows.filter((r) => r.caller_phone && owned.has(r.caller_phone))
const targets = all.filter((r) => ALL || r.created_at >= LIVE_BUG_SINCE)
const already = targets.filter((r) => r.is_junk && r.status === "dead" && !r.drip_campaign_type)
const todo = targets.filter((r) => !(r.is_junk && r.status === "dead" && !r.drip_campaign_type))

console.log(`${all.length} phantom rows total; ${targets.length} in scope${ALL ? " (--all)" : ` (since ${LIVE_BUG_SINCE})`}`)
console.log(`${already.length} already neutralized, ${todo.length} to fix`)
console.log(`${WRITE ? "WRITING" : "DRY RUN — pass --write to apply"}\n`)

let n = 0
for (const r of todo) {
  const drip = r.drip_campaign_type ? `  ⚠ DRIP=${r.drip_campaign_type}` : ""
  const label = `${r.created_at.slice(0, 16)} ${r.caller_phone} ${r.lead_type.padEnd(13)} ${String(r.status).padEnd(9)}${drip}`
  if (!WRITE) { console.log(`  + ${label}`); n++; continue }
  const res = await fetch(`${SB}/rest/v1/leads?id=eq.${r.id}`, {
    method: "PATCH",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ is_junk: true, status: "dead", drip_campaign_type: null }),
  })
  if (!res.ok) { console.log(`  ✗ ${r.id.slice(0, 8)} → ${res.status} ${await res.text()}`); continue }
  console.log(`  + ${label}`)
  n++
}
if (!ALL && all.length > targets.length) {
  console.log(`\n${all.length - targets.length} older rows left alone (May/July build-out tests). Re-run with --all to include them.`)
}
console.log(`\n${WRITE ? "done" : "dry run"}: ${n} row(s)`)
