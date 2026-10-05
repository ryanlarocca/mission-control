#!/usr/bin/env node
// Diagnostic: how were messages from a sender (substring) classified? node diag-sender.mjs kiavi
import { loadEnvLocal, sb } from "../env.mjs"
import { getMessage, gmailClient } from "../gmail.mjs"
loadEnvLocal()
const needle = process.argv[2] || "kiavi"
const { data } = await sb().from("inbox_messages").select("gmail_id, internal_date, sender, subject, kind, classification").ilike("sender", `%${needle}%`).gte("internal_date", "2026-09-24").order("internal_date")
const gmail = await gmailClient()
for (const m of data || []) {
  const c = m.classification || {}
  console.log(`\n=== ${m.internal_date.slice(0, 16)} | ${m.sender} | ${m.subject}`)
  console.log(`kind=${m.kind} is_human=${c.is_human} needs_reply=${c.needs_reply} solicitation=${c.solicitation} priority=${c.priority} category=${c.category} property=${c.property?.label}`)
  console.log(`ask=${c.ask} | summary=${c.summary}`)
  try {
    const full = await getMessage(gmail, m.gmail_id)
    console.log("BODY:", full.text.replace(/\s+/g, " ").slice(0, 600))
  } catch (e) {
    console.log("body unavailable:", e.message)
  }
}
const { data: loops } = await sb().from("inbox_loops").select("created_at, status, counterparty_email, ask").ilike("counterparty_email", `%${needle}%`)
console.log("\nloops:", JSON.stringify(loops))
