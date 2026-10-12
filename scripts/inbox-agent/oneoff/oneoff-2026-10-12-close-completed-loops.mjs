#!/usr/bin/env node
// One-off 2026-10-12: signature loops created BY a "Completed:" email (the
// Ridgeview card Ryan kept seeing — loop 25a67d93-3038-48e2-8809-15460b16a190)
// nag him to sign something already signed. Mark every open/snoozed/
// acknowledged category='signature' loop whose subject starts with "Completed:"
// as resolved_by_event and clear its card buttons. Dry-run by default; --apply to write.
import { loadEnvLocal, sb } from "../env.mjs"
import { tgClearButtons } from "../telegram.mjs"
loadEnvLocal()
const APPLY = process.argv.includes("--apply")
const { data: loops, error } = await sb().from("inbox_loops").select("id, subject, counterparty, ask, status, tg_message_id").eq("category", "signature").in("status", ["open", "snoozed", "acknowledged"]).ilike("subject", "completed:%")
if (error) throw new Error(error.message)
for (const l of loops || []) {
  console.log(`close | ${l.id} | ${String(l.status).padEnd(12)} | ${String(l.counterparty).slice(0, 28).padEnd(28)} | ${String(l.subject).slice(0, 70)}`)
  if (!APPLY) continue
  await sb().from("inbox_loops").update({ status: "resolved_by_event", resolved_at: new Date().toISOString() }).eq("id", l.id)
  if (l.tg_message_id) await tgClearButtons(l.tg_message_id)
}
console.log(`${loops?.length || 0} completed-envelope loop(s)${APPLY ? " closed" : " would close (add --apply)"}`)
