#!/usr/bin/env node
/* eslint-disable */
/**
 * Personal-cell cadence heartbeat.
 *
 * Leads flagged `use_personal_cell` are texted from Ryan's phone and excluded
 * from the drip engine, but they STILL appear in the Follow-Ups worklist,
 * whose "overdue" forecast keys off `last_drip_sent_at` (lib/next-touch.ts).
 * When Ryan texts one of these leads natively from his phone, nothing in CRMS
 * logs it — so without this job, `last_drip_sent_at` never advances and the
 * lead nags as perpetually overdue.
 *
 * This poller reads chat.db (via the sidecar /sync-imessage endpoint) for each
 * personal-cell lead's phone, finds the most recent message in EITHER
 * direction, and bumps `last_drip_sent_at` to match. It writes a single
 * timestamp — no message bodies, no alerts — so it's far lighter than full
 * inbound logging, and it keeps the Follow-Ups clock honest.
 *
 * Run hourly via launchd
 * (infrastructure/launchd/com.lrghomes.personal-cell-heartbeat.plist).
 * Needs the sidecar reachable on SIDECAR_URL.
 *
 * Usage:
 *   node scripts/personal-cell-heartbeat.js            # one pass
 *   node scripts/personal-cell-heartbeat.js --dry-run  # report, don't write
 */

"use strict"

const fs = require("node:fs")
const path = require("node:path")
const { createClient } = require("@supabase/supabase-js")

// ─── env loader (matches scripts/drip-engine.js) ────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")

function loadEnvLocal() {
  if (!fs.existsSync(ENV_PATH)) return
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnvLocal()

const DRY_RUN = process.argv.slice(2).includes("--dry-run")
const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"
const APPLE_EPOCH_OFFSET_MS = 978307200000 // chat.db timestamps are Apple-epoch ms

function getSupabase() {
  const url = process.env.LRG_SUPABASE_URL
  const key = process.env.LRG_SUPABASE_SERVICE_KEY
  if (!url || !key) {
    throw new Error("LRG_SUPABASE_URL and LRG_SUPABASE_SERVICE_KEY must be set")
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

// Latest chat.db message timestamp (Apple-epoch ms) for a phone, or null.
async function latestChatDbActivity(phone) {
  try {
    const res = await fetch(`${SIDECAR_URL}/sync-imessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    })
    if (!res.ok) {
      console.warn(`[heartbeat] sync-imessage HTTP ${res.status} for ${phone}`)
      return null
    }
    const data = await res.json()
    const messages = Array.isArray(data.messages) ? data.messages : []
    let maxApple = null
    for (const m of messages) {
      const t = Number(m.timestamp)
      if (Number.isFinite(t) && (maxApple === null || t > maxApple)) maxApple = t
    }
    return maxApple
  } catch (e) {
    console.warn(`[heartbeat] sync-imessage error for ${phone}:`, e.message)
    return null
  }
}

async function main() {
  const sb = getSupabase()

  // All personal-cell rows with a phone. Group by phone so we do one sidecar
  // call + one update per cluster, not per row.
  const { data: rows, error } = await sb
    .from("leads")
    .select("id, caller_phone, last_drip_sent_at")
    .eq("use_personal_cell", true)
    .not("caller_phone", "is", null)
  if (error) {
    console.error("[heartbeat] lead query failed:", error.message)
    process.exit(1)
  }

  const byPhone = new Map()
  for (const r of rows || []) {
    const p = r.caller_phone
    if (!p || !/\d/.test(p)) continue
    if (!byPhone.has(p)) byPhone.set(p, [])
    byPhone.get(p).push(r)
  }

  console.log(`[heartbeat] ${byPhone.size} personal-cell phone(s) to check${DRY_RUN ? " (dry-run)" : ""}`)
  let bumped = 0

  for (const [phone, clusterRows] of byPhone) {
    const maxApple = await latestChatDbActivity(phone)
    if (maxApple === null) continue // no chat.db history (or sidecar down) — leave the clock alone

    const latestUnixMs = maxApple + APPLE_EPOCH_OFFSET_MS
    if (latestUnixMs > Date.now()) continue // guard against a bogus future timestamp

    // Current cluster clock = newest last_drip_sent_at across its rows.
    let clusterMaxMs = 0
    for (const r of clusterRows) {
      if (r.last_drip_sent_at) {
        const ms = new Date(r.last_drip_sent_at).getTime()
        if (ms > clusterMaxMs) clusterMaxMs = ms
      }
    }

    // Only advance — never move the cadence clock backward.
    if (latestUnixMs <= clusterMaxMs) continue

    const latestIso = new Date(latestUnixMs).toISOString()
    console.log(`[heartbeat] ${phone}: bump last_drip_sent_at → ${latestIso} (${clusterRows.length} row(s))`)
    bumped++
    if (DRY_RUN) continue

    const { error: updErr } = await sb
      .from("leads")
      .update({ last_drip_sent_at: latestIso })
      .eq("caller_phone", phone)
      .eq("use_personal_cell", true)
    if (updErr) console.warn(`[heartbeat] update failed for ${phone}:`, updErr.message)
  }

  console.log(`[heartbeat] done — ${bumped} cluster(s) ${DRY_RUN ? "would be" : ""} bumped`)
}

main().catch((e) => {
  console.error("[heartbeat] fatal:", e)
  process.exit(1)
})
