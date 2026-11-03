#!/usr/bin/env node
/**
 * Rewrite the `message` on existing pending drip_queue rows with the current
 * writer (Mission Control's Opus coach writer via /api/reply/drip-draft,
 * the same path the engine uses since 2026-11-03). Use after a writer or
 * prompt change so queued drips pick it up without skip + re-queue (which
 * would push the touch counter forward).
 *
 * Skips rows Ryan edited, rows already on the current writer, and any row
 * whose text changed while the rewrite ran. Three at a time.
 *
 * Usage:
 *   node scripts/regenerate-pending-drips.js                       # all pending
 *   node scripts/regenerate-pending-drips.js --lead <lead_uuid>    # single lead
 *   node scripts/regenerate-pending-drips.js --dry-run             # preview only
 *   node scripts/regenerate-pending-drips.js --limit 5             # first N rows
 *   node scripts/regenerate-pending-drips.js --blanks --force      # redo rows with a [BLANK]
 *   node scripts/regenerate-pending-drips.js --force --match "voicemail|sorry"   # redo matching rows
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
// --force: rewrite even rows already on the current writer.
// --blanks: only rows whose text has a bracketed blank ([FIRST NAME]).
const FORCE = args.includes("--force")
const BLANKS_ONLY = args.includes("--blanks")
// --match <regex>: only rows whose text matches (case-insensitive).
const MATCH = (() => { const i = args.indexOf("--match"); return i >= 0 ? new RegExp(args[i + 1], "i") : null })()

// Pull the engine's exports. We require() the engine file directly — it
// runs main() on import, but we set DRIP_REGEN_SKIP_MAIN to short-circuit.
process.env.DRIP_REGEN_SKIP_MAIN = "1"
const engine = require("./drip-engine.js")

const { createClient } = require(path.join(REPO_ROOT, "node_modules/@supabase/supabase-js"))
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

const CURRENT_PROMPT = "auto-coach-v1-2026-11-03"
const CONCURRENCY = 3

async function rewriteRow(row) {
  const { data: drafts } = await sb.from("reply_drafts").select("id, model, prompt_version, draft_body").eq("drip_queue_id", row.id).order("created_at", { ascending: true })
  const latest = drafts && drafts.length ? drafts[drafts.length - 1] : null
  if ((drafts || []).some((d) => d.model === "ryan-edit")) return { skip: "edited by Ryan" }
  if (MATCH && !MATCH.test(row.message || "")) return { skip: "no match" }
  if (BLANKS_ONLY && !/\[[A-Z][A-Z ]+\]/.test(`${row.subject || ""} ${row.message || ""}`)) return { skip: "no blank" }
  if (!FORCE && latest && latest.prompt_version === CURRENT_PROMPT) return { skip: "already on the new writer" }
  if (latest && latest.draft_body && latest.draft_body.trim() !== (row.message || "").trim()) return { skip: "text differs from its draft (hand-edited)" }

  const { data: lead } = await sb.from("leads").select("*").eq("id", row.lead_id).maybeSingle()
  if (!lead) return { skip: "lead not found" }
  const campaign = engine.DRIP_CAMPAIGNS[row.campaign_type] || engine.DRIP_CAMPAIGNS[lead.drip_campaign_type]
  if (!campaign) return { skip: `unknown campaign ${row.campaign_type}` }
  const history = await engine.buildConversationHistory(lead, sb)
  const responsiveness = await engine.extractResponsivenessSignals(lead, sb)
  const daysSinceCreated = Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86400000)
  const out = await engine.writeTouchWithOpus({ lead, campaign, touchNumber: row.touch_number, channel: row.channel, history, clarify: false, daysSinceCreated, responsiveness })
  if (!out.draft) return { fail: out.error }
  const name = lead.name || lead.caller_phone || lead.email || "(unknown)"
  const preview = `${row.id.slice(0, 8)} ${name} touch #${row.touch_number}\n    OLD: ${row.message.slice(0, 160).replace(/\n/g, " ")}\n    NEW: ${out.draft.body.slice(0, 160).replace(/\n/g, " ")}`
  if (DRY_RUN) return { ok: preview }
  // Only if nothing touched the row meanwhile (Ryan may be working the queue).
  const { data: upd, error: upErr } = await sb.from("drip_queue").update({ message: out.draft.body })
    .eq("id", row.id).eq("status", "pending").eq("message", row.message).select("id")
  if (upErr) return { fail: upErr.message }
  if (!upd || !upd.length) return { skip: "changed or sent while rewriting" }
  await engine.recordDripDraft(sb, { lead, queueId: row.id, channel: row.channel, message: out.draft.body, subject: row.subject, critic: out.draft.critic || null, parentId: latest && latest.id, writer: out.draft })
  return { ok: preview }
}

async function main() {
  let q = sb.from("drip_queue").select("*").eq("status", "pending").order("created_at", { ascending: true })
  if (LEAD_FILTER) q = q.eq("lead_id", LEAD_FILTER)
  if (LIMIT) q = q.limit(LIMIT)
  const { data: rows, error } = await q
  if (error) { console.error("query failed:", error.message); process.exit(1) }
  if (!rows || rows.length === 0) { console.log("no pending rows to rewrite."); return }
  console.log(`rewriting ${rows.length} pending drip(s)${DRY_RUN ? " (DRY RUN)" : ""}`)

  let ok = 0, skip = 0, fail = 0
  const queue = rows.slice()
  async function worker() {
    while (queue.length) {
      const row = queue.shift()
      let r
      try { r = await rewriteRow(row) } catch (e) { r = { fail: e.message } }
      if (r.ok) { ok++; console.log(`\n  ${r.ok}`) }
      else if (r.skip) { skip++; console.log(`  ${row.id.slice(0, 8)}: skip — ${r.skip}`) }
      else { fail++; console.warn(`  ${row.id.slice(0, 8)}: FAILED — ${r.fail}`) }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`\ndone — ok=${ok} skip=${skip} fail=${fail}`)
}
main().catch(e => { console.error("fatal:", e); process.exit(1) })
