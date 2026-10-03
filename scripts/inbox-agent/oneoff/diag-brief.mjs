#!/usr/bin/env node
// Diagnostic: what fed this morning's brief? Open loops, recent screens, recent message kinds.
import { loadEnvLocal, sb, getSetting } from "../env.mjs"
loadEnvLocal()
const since = new Date(Date.now() - 3 * 86_400_000).toISOString()
const { data: loops } = await sb().from("inbox_loops").select("created_at, counterparty, counterparty_email, category, ask, priority, status, subject").in("status", ["open", "snoozed", "acknowledged"]).order("created_at")
console.log(`=== loops (${loops?.length}) open/snoozed/acknowledged`)
for (const l of loops || []) console.log(`${l.created_at.slice(0, 10)} | ${l.status.padEnd(12)} | ${l.priority.padEnd(6)} | ${l.category.padEnd(9)} | ${String(l.counterparty).slice(0, 28).padEnd(28)} | ${String(l.ask).slice(0, 70)} | "${String(l.subject).slice(0, 40)}"`)
const { data: screens } = await sb().from("inbox_deal_screens").select("created_at, address, tier, verdict, facts, tg_message_id").gte("created_at", since).order("created_at")
console.log(`\n=== deal screens since ${since.slice(0, 10)} (${screens?.length})`)
for (const s of screens || []) console.log(`${s.created_at.slice(0, 16)} | ${s.tier.padEnd(6)} | ${String(s.verdict).padEnd(12)} | shown=${s.facts?.shown} card=${s.tg_message_id ? "yes" : "no"} | ${s.address} | ${s.facts?.cut || ""}`)
const { data: msgs } = await sb().from("inbox_messages").select("internal_date, sender, subject, kind, classification").gte("internal_date", since).order("internal_date")
console.log(`\n=== messages since ${since.slice(0, 10)} (${msgs?.length})`)
for (const m of msgs || []) {
  const c = m.classification || {}
  console.log(`${m.internal_date.slice(5, 16)} | ${String(m.kind).padEnd(18)} | ${String(m.sender).slice(0, 30).padEnd(30)} | ${String(m.subject).slice(0, 50).padEnd(50)} | deal=${c.deal?.tier || "-"} reply=${c.needs_reply ?? "-"} human=${c.is_human ?? "-"}`)
}
const agent = await getSetting("agent")
console.log("\n=== agent settings:", JSON.stringify({ loop_alerts: agent.loop_alerts, last_digest_date: agent.last_digest_date, watermark: agent.watermark }))
