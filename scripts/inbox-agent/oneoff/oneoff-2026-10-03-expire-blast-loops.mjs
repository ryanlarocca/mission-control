#!/usr/bin/env node
// One-off 2026-10-03: the morning brief was re-posting flyer agents as "Waiting on you" loops.
// Expire every open loop that isn't escrow or a signature (the 10 flyer/lender-marketing
// loops + Dominic's past Zoom invite) and clear their card buttons. --apply to write.
import { loadEnvLocal, sb } from "../env.mjs"
import { tgClearButtons } from "../telegram.mjs"
loadEnvLocal()
const APPLY = process.argv.includes("--apply")
const { data: loops } = await sb().from("inbox_loops").select("id, counterparty, category, ask, tg_message_id, status").eq("status", "open").not("category", "in", '("escrow","signature")')
for (const l of loops || []) {
  console.log(`expire | ${l.category.padEnd(9)} | ${String(l.counterparty).slice(0, 30).padEnd(30)} | ${String(l.ask).slice(0, 60)}`)
  if (!APPLY) continue
  await sb().from("inbox_loops").update({ status: "expired", resolved_at: new Date().toISOString() }).eq("id", l.id)
  if (l.tg_message_id) await tgClearButtons(l.tg_message_id)
}
console.log(`${loops?.length || 0} loops${APPLY ? " expired" : " would expire (add --apply)"}`)
