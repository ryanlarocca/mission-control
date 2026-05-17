#!/usr/bin/env node
/**
 * Regenerate the `message` field on existing pending drip_queue rows using
 * the current drip-engine prompt. Use this after a prompt change (e.g.
 * adding responsiveness signals) so previously-queued drips pick up the
 * new tone without having to skip + re-queue (which would push the touch
 * counter forward).
 *
 * Usage:
 *   node scripts/regenerate-pending-drips.js                       # all pending
 *   node scripts/regenerate-pending-drips.js --lead <lead_uuid>    # single lead
 *   node scripts/regenerate-pending-drips.js --dry-run             # preview only
 *   node scripts/regenerate-pending-drips.js --limit 5             # first N rows
 */

"use strict"

const fs = require("node:fs")
const path = require("node:path")

const REPO_ROOT = path.resolve(__dirname, "..")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")
for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) continue
  const eq = trimmed.indexOf("=")
  if (eq < 0) continue
  const key = trimmed.slice(0, eq).trim()
  let val = trimmed.slice(eq + 1).trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
  if (process.env[key] === undefined) process.env[key] = val
}

const args = process.argv.slice(2)
const DRY_RUN = args.includes("--dry-run")
const LEAD_FILTER = (() => { const i = args.indexOf("--lead"); return i >= 0 ? args[i + 1] : null })()
const LIMIT = (() => { const i = args.indexOf("--limit"); return i >= 0 ? parseInt(args[i + 1], 10) : null })()

// Pull the engine's exports. We require() the engine file directly — it
// runs main() on import, but we set DRIP_REGEN_SKIP_MAIN to short-circuit.
process.env.DRIP_REGEN_SKIP_MAIN = "1"
const engine = require("./drip-engine.js")

const { createClient } = require(path.join(REPO_ROOT, "node_modules/@supabase/supabase-js"))
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

async function main() {
  let q = sb.from("drip_queue").select("*").eq("status", "pending").order("created_at", { ascending: true })
  if (LEAD_FILTER) q = q.eq("lead_id", LEAD_FILTER)
  if (LIMIT) q = q.limit(LIMIT)
  const { data: rows, error } = await q
  if (error) { console.error("query failed:", error.message); process.exit(1) }
  if (!rows || rows.length === 0) { console.log("no pending rows to regenerate."); return }
  console.log(`regenerating ${rows.length} pending drip(s)${DRY_RUN ? " (DRY RUN)" : ""}`)

  let ok = 0, skip = 0, fail = 0
  for (const row of rows) {
    const { data: lead } = await sb.from("leads").select("*").eq("id", row.lead_id).maybeSingle()
    if (!lead) { console.warn(`  row ${row.id.slice(0,8)}: lead not found — skipping`); skip++; continue }

    const campaign = engine.DRIP_CAMPAIGNS[lead.drip_campaign_type]
    if (!campaign) { console.warn(`  row ${row.id.slice(0,8)}: unknown campaign ${lead.drip_campaign_type} — skipping`); skip++; continue }

    const history = await engine.buildConversationHistory(lead, sb)
    const responsiveness = await engine.extractResponsivenessSignals(lead, sb)
    const daysSinceCreated = Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86400000)

    const newMessage = await engine.generateMessage({
      lead,
      campaign,
      touchNumber: row.touch_number,
      channel: row.channel,
      history,
      clarify: false, // suppress clarify on regen — most leads we're regenerating are unresponsive
      daysSinceCreated,
      responsiveness,
    })
    if (!newMessage) { console.warn(`  row ${row.id.slice(0,8)}: generation failed`); fail++; continue }

    const name = lead.name || lead.caller_phone || lead.email || "(unknown)"
    console.log(`\n  ${row.id.slice(0,8)} ${name} touch #${row.touch_number} state=${responsiveness?.state || "n/a"}`)
    console.log(`    OLD: ${row.message.slice(0, 140).replace(/\n/g, " ")}`)
    console.log(`    NEW: ${newMessage.slice(0, 140).replace(/\n/g, " ")}`)

    if (!DRY_RUN) {
      const { error: upErr } = await sb.from("drip_queue").update({ message: newMessage }).eq("id", row.id).eq("status", "pending")
      if (upErr) { console.error(`    update failed: ${upErr.message}`); fail++; continue }
    }
    ok++
  }
  console.log(`\ndone — ok=${ok} skip=${skip} fail=${fail}`)
}
main().catch(e => { console.error("fatal:", e); process.exit(1) })
