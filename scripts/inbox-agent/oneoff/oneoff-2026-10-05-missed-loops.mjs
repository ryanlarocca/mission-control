#!/usr/bin/env node
// One-off 2026-10-05: two real asks the worker dropped because the sender looked automated —
// Kiavi servicing's ACH form for the Halleck draws (10/05) and StyleMe Home Staging's proposal +
// invoice via FreshBooks (10/03, 10/04). Create the loops and post their cards now.
import { loadEnvLocal, sb } from "../env.mjs"
import { esc, tgSend } from "../telegram.mjs"
loadEnvLocal()
const APPLY = process.argv.includes("--apply")
const wanted = [
  { match: { sender: "servicing@kiavi.com", subject: "RE: 5764 Halleck drive" }, ask: "Return Kiavi's ACH form (voided check or bank letter) to update the account for the Halleck construction draws — confirm payments-only or payments + draws.", category: "lender", priority: "high", counterparty: "Kiavi Servicing" },
  { match: { sender: "mail@fb02.freshbooks.com", subject: "StyleMe Home Staging, LLC sent you an invoice" }, ask: "Pay StyleMe Home Staging invoice 080223UP.", category: "vendor", priority: "normal", counterparty: "StyleMe Home Staging" },
  { match: { sender: "mail@fb02.freshbooks.com", subject: "StyleMe Home Staging, LLC sent you a proposal" }, ask: "Review / approve StyleMe Home Staging proposal SS01168.", category: "vendor", priority: "normal", counterparty: "StyleMe Home Staging" },
]
for (const w of wanted) {
  const { data: msgs } = await sb().from("inbox_messages").select("gmail_id, thread_id, subject, sender, internal_date").eq("sender", w.match.sender).ilike("subject", `${w.match.subject}%`).order("internal_date", { ascending: false }).limit(1)
  const m = msgs?.[0]
  if (!m) {
    console.log("not found:", w.match)
    continue
  }
  const { data: existing } = await sb().from("inbox_loops").select("id, status").eq("thread_id", m.thread_id).in("status", ["open", "snoozed", "acknowledged"]).limit(1)
  if (existing?.length) {
    console.log("loop exists:", w.ask)
    continue
  }
  console.log(`${APPLY ? "create" : "would create"} loop: ${w.ask}`)
  if (!APPLY) continue
  const { data: loop } = await sb().from("inbox_loops").insert({ thread_id: m.thread_id, gmail_id: m.gmail_id, subject: m.subject, counterparty: w.counterparty, counterparty_email: m.sender, category: w.category, ask: w.ask, priority: w.priority, status: "open" }).select("id").single()
  const card = `${w.priority === "high" ? "🔴" : "•"} <b>${esc(w.counterparty)}</b> — ${esc(w.ask)}\n“${esc(m.subject)}”`
  const mid = await tgSend(card, { rows: [[{ text: "✓ Done", data: `ix:ld:${loop.id}` }, { text: "👀 Got it", data: `ix:la:${loop.id}` }, { text: "⏰ Snooze 2d", data: `ix:lz:${loop.id}` }]] })
  await sb().from("inbox_loops").update({ tg_message_id: mid, alerted_at: new Date().toISOString() }).eq("id", loop.id)
}
