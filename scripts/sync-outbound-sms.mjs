#!/usr/bin/env node
// Sync outbound SMS sent through Twilio that aren't logged in the leads
// table. The drip engine and the leads-tab Send button both insert rows
// when they send (drip_imessage / sms), but anything sent via Twilio
// directly — most notably the lrghomes-landing auto-replies after a form
// submit — never makes it back into mission-control. This script polls
// Twilio's Messages API every few minutes and inserts an outbound row
// for any message that isn't already there.
//
// Usage:
//   node scripts/sync-outbound-sms.mjs                     # last 24h, dry-run
//   node scripts/sync-outbound-sms.mjs --execute           # do inserts
//   node scripts/sync-outbound-sms.mjs --hours=4 --execute
//
// Match rules (to dedupe against existing rows):
//   - lead_type IN ('sms','drip_imessage')
//   - twilio_number IS NULL (outbound convention)
//   - caller_phone = Twilio To
//   - first 200 chars of message body match
//   - row created within ±60 min of Twilio date_sent
//
// Cluster inheritance for new inserts: source / source_type /
// drip_campaign_type / status carry from the cluster's most recent row
// (same pattern as inbound sms/voice/email after the nurture work).

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

const args = process.argv.slice(2)
const execute = args.includes("--execute")
const hoursArg = args.find(a => a.startsWith("--hours="))
const hours = hoursArg ? parseInt(hoursArg.split("=")[1], 10) : 24

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)
const tw = { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN }
if (!tw.sid || !tw.token) { console.error("Missing Twilio creds"); process.exit(1) }
const auth = Buffer.from(`${tw.sid}:${tw.token}`).toString("base64")

const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
console.log(`Mode: ${execute ? "EXECUTE" : "DRY-RUN"}    window: last ${hours}h (since ${sinceIso})`)

// ── 1. Pull outbound-api messages from Twilio in window ─────────────────────
const messages = []
let nextUrl = `https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Messages.json?DateSent%3E=${encodeURIComponent(sinceIso)}&PageSize=200`
while (nextUrl) {
  const r = await fetch(nextUrl, { headers: { Authorization: `Basic ${auth}` } })
  if (!r.ok) { console.error(`Twilio ${r.status}: ${await r.text()}`); process.exit(1) }
  const body = await r.json()
  messages.push(...(body.messages || []))
  nextUrl = body.next_page_uri ? `https://api.twilio.com${body.next_page_uri}` : null
}
const outbound = messages.filter(m => m.direction && m.direction.startsWith("outbound"))
console.log(`Twilio: ${messages.length} message(s) total, ${outbound.length} outbound in window.`)

// ── 2. For each outbound, check if it's already logged ──────────────────────
async function existingOutboundRow(toPhone, bodyPrefix200, dateSentMs) {
  // Match within ±60 min of Twilio's date_sent.
  const lo = new Date(dateSentMs - 60 * 60 * 1000).toISOString()
  const hi = new Date(dateSentMs + 60 * 60 * 1000).toISOString()
  const { data } = await sb
    .from("leads")
    .select("id, message, created_at, lead_type")
    .eq("caller_phone", toPhone)
    .in("lead_type", ["sms", "drip_imessage"])
    .is("twilio_number", null)
    .gte("created_at", lo)
    .lte("created_at", hi)
    .limit(20)
  if (!data) return null
  for (const row of data) {
    const rowPrefix = (row.message || "").slice(0, 200)
    if (rowPrefix === bodyPrefix200) return row
  }
  return null
}

// Look up cluster identity for a phone (most recent row gives us status +
// source + drip_campaign_type to inherit).
async function clusterIdentity(toPhone) {
  const { data } = await sb
    .from("leads")
    .select("source, source_type, drip_campaign_type, status, name, property_address, email")
    .eq("caller_phone", toPhone)
    .order("created_at", { ascending: false })
    .limit(1)
  return data?.[0] ?? null
}

const plan = []
const skipped = []
for (const m of outbound) {
  if (!m.to || !m.body) { skipped.push({ m, reason: "no to/body" }); continue }
  const bodyPrefix200 = m.body.slice(0, 200)
  const dateSentMs = new Date(m.date_sent || m.date_created).getTime()
  const existing = await existingOutboundRow(m.to, bodyPrefix200, dateSentMs)
  if (existing) { skipped.push({ m, reason: `already logged (id=${existing.id.slice(0,8)})` }); continue }
  const cluster = await clusterIdentity(m.to)
  if (!cluster) { skipped.push({ m, reason: "no cluster — recipient isn't a known lead" }); continue }
  plan.push({ msg: m, cluster })
}

console.log("")
console.log(`Plan: ${plan.length} to insert, ${skipped.length} skipped.`)
for (const p of plan) {
  const preview = p.msg.body.slice(0, 80).replace(/\n/g, " ")
  console.log(`  INSERT  ${p.msg.date_sent}  ${p.msg.from} → ${p.msg.to}  status=${p.msg.status}  cluster=${p.cluster.name||"(no name)"}/${p.cluster.status}`)
  console.log(`          "${preview}${p.msg.body.length > 80 ? "…" : ""}"`)
}
if (skipped.length > 0 && skipped.length <= 20) {
  for (const s of skipped) {
    console.log(`  SKIP    ${s.m.date_sent}  ${s.m.from} → ${s.m.to}  (${s.reason})`)
  }
} else if (skipped.length > 0) {
  const counts = {}
  for (const s of skipped) counts[s.reason] = (counts[s.reason] || 0) + 1
  for (const [r, c] of Object.entries(counts)) console.log(`  SKIP×${c}  ${r}`)
}

if (!execute) {
  console.log("\nDry-run — re-run with --execute to insert.")
  process.exit(0)
}

// ── 3. Insert rows. Carry drip_campaign_type forward but don't reset clock. ─
let ok = 0, fail = 0
for (const p of plan) {
  const row = {
    source: p.cluster.source,
    source_type: p.cluster.source_type,
    twilio_number: null, // outbound convention
    caller_phone: p.msg.to,
    lead_type: "sms",
    message: p.msg.body,
    status: p.cluster.status || "new",
    name: p.cluster.name,
    email: p.cluster.email,
    property_address: p.cluster.property_address,
    created_at: p.msg.date_sent || p.msg.date_created, // preserve real send time
  }
  if (p.cluster.drip_campaign_type) row.drip_campaign_type = p.cluster.drip_campaign_type
  const { error } = await sb.from("leads").insert(row)
  if (error) { console.log(`  ✗ ${p.msg.sid}: ${error.message}`); fail++ }
  else { console.log(`  ✓ ${p.msg.sid}  to=${p.msg.to}`); ok++ }
}
console.log(`\nDone. ${ok} inserted, ${fail} failed.`)
