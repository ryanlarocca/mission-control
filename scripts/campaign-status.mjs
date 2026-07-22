#!/usr/bin/env node
/**
 * Agent email-drip campaign — one-shot status report.
 *
 *   node scripts/campaign-status.mjs
 *
 * Built for ANY agent (Telegram/OpenClaw/Claude) or human who needs the
 * campaign state without knowing the schema: prints everything that
 * matters in plain English. READ-ONLY — makes no changes.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
for (const line of fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf-8").split(/\r?\n/)) {
  const eq = line.indexOf("=")
  if (eq < 0 || line.trim().startsWith("#")) continue
  const key = line.slice(0, eq).trim()
  let val = line.slice(eq + 1).trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
  if (process.env[key] === undefined) process.env[key] = val
}
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
})

const count = async (table, mods) => {
  let q = sb.from(table).select("id", { count: "exact", head: true })
  q = mods(q)
  const { count: n, error } = await q
  if (error) throw new Error(`${table}: ${error.message}`)
  return n ?? 0
}
const startOfToday = new Date()
startOfToday.setHours(0, 0, 0, 0)
const today = startOfToday.toISOString()

const [active, paused, replied, bounced, unsub, suppressed, badEmail] = await Promise.all(
  ["active", "paused", "replied", "bounced", "unsubscribed", "suppressed", "bad_email"].map((s) =>
    count("campaign_contacts", (q) => q.eq("status", s))
  )
)
const [drafts, approvedQ, sentToday, sentTotal, failed] = await Promise.all([
  count("campaign_sends", (q) => q.eq("status", "draft")),
  count("campaign_sends", (q) => q.eq("status", "approved")),
  count("campaign_sends", (q) => q.eq("status", "sent").gte("sent_at", today)),
  count("campaign_sends", (q) => q.eq("status", "sent")),
  count("campaign_sends", (q) => q.eq("status", "failed")),
])
const [bouncesToday, repliesToday, alertFailures] = await Promise.all([
  count("campaign_events", (q) => q.eq("kind", "bounce").gte("occurred_at", today)),
  count("campaign_events", (q) => q.eq("kind", "email_reply").is("triage", null).gte("occurred_at", today)),
  count("campaign_events", (q) => q.eq("triage", "alert_failure")),
])
const { data: recentReplies } = await sb
  .from("campaign_events")
  .select("occurred_at, body, contact:campaign_contacts (name, email)")
  .eq("kind", "email_reply")
  .is("triage", null)
  .order("occurred_at", { ascending: false })
  .limit(5)

let engineLast = "unknown"
try {
  engineLast = fs.statSync("/tmp/lrg-campaign-engine.log").mtime.toLocaleString()
} catch { /* log missing */ }

console.log(`AGENT EMAIL CAMPAIGN — STATUS ${new Date().toLocaleString()}
================================================================
CONTACTS   active ${active} · paused ${paused} · replied ${replied} · bounced ${bounced}
           unsubscribed ${unsub} · suppressed ${suppressed} · bad email ${badEmail}
TODAY      sent ${sentToday} · bounces ${bouncesToday} · human replies ${repliesToday}
QUEUE      ${drafts} drafts awaiting Ryan's review · ${approvedQ} approved${approvedQ > 0 ? " (will send in the next engine pass, Mon-Fri 9:00-16:30 PT)" : ""}
ALL-TIME   ${sentTotal} sent · ${failed} failed sends · ${alertFailures} alert failures
ENGINE     last activity: ${engineLast} (launchd, every 20 min)

RECENT HUMAN REPLIES (newest first):`)
for (const r of recentReplies ?? []) {
  const when = new Date(r.occurred_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
  console.log(`  - ${when} · ${r.contact?.name ?? r.contact?.email}: "${(r.body ?? "").slice(0, 90).replace(/\n/g, " ")}"`)
}
if (!recentReplies?.length) console.log("  (none yet)")
console.log(`
NOTES: bounces are handled automatically (digest per batch on Telegram).
Approvals/sending/changes happen in Mission Control /email-campaign or
Ryan's Claude session — NOT from here.`)
