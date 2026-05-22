#!/usr/bin/env node
// Reply detection for the Relationships tab — Phase 1 of
// briefs/RELATIONSHIPS_REPLY_TRACKING.md.
//
// For every action='sent' relationship_touch, checks the contact's iMessage
// history (chat.db, via the CRMS sidecar's POST /sync-imessage) for an
// inbound reply within 7 days and writes relationship_touches.replied_at.
//
// A reply is attributed to the latest sent touch before it — a touch's reply
// window ends when the next sent touch to that contact happens, so one reply
// is never double-counted across two touches.
//
// Idempotent. Runs on the Mac mini (needs the sidecar at localhost:5799).
//   node scripts/detect-relationship-replies.mjs [--dry-run]

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

// --- env (.env.local) ---
for (const line of fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (process.env[m[1]] === undefined) process.env[m[1]] = v
}
const SUPABASE_URL = process.env.LRG_SUPABASE_URL
const SUPABASE_KEY = process.env.LRG_SUPABASE_SERVICE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("✗ LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing")
  process.exit(1)
}

const SIDECAR = process.env.SIDECAR_URL || "http://localhost:5799"
const DRY_RUN = process.argv.includes("--dry-run")
const APPLE_EPOCH = new Date("2001-01-01T00:00:00Z").getTime() // chat.db ts base
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

// Page past PostgREST's 1000-row response cap.
async function fetchAll(table, columns, applyFilters) {
  const out = []
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(columns).order("id", { ascending: true }).range(from, from + 999)
    if (applyFilters) q = applyFilters(q)
    const { data, error } = await q
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}

async function main() {
  // --- relationships: id -> phone ---
  const idToPhone = new Map()
  for (const r of await fetchAll("relationships", "id, phone")) {
    if (r.phone) idToPhone.set(r.id, r.phone)
  }

  // --- all sent touches ---
  const touches = await fetchAll(
    "relationship_touches",
    "id, relationship_id, occurred_at, replied_at",
    (q) => q.eq("action", "sent"),
  )

  // --- group sent touches by contact phone ---
  const byPhone = new Map()
  let noPhone = 0
  for (const t of touches) {
    const phone = idToPhone.get(t.relationship_id)
    if (!phone) { noPhone++; continue }
    if (!byPhone.has(phone)) byPhone.set(phone, [])
    byPhone.get(phone).push(t)
  }

  let checked = 0, withReply = 0, sidecarFails = 0
  const updates = [] // { id, replied_at }

  for (const [phone, phoneTouches] of byPhone) {
    // inbound iMessages for this contact, as sorted JS-ms timestamps
    let inbound
    try {
      const res = await fetch(`${SIDECAR}/sync-imessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
        signal: AbortSignal.timeout(20000),
      })
      const data = await res.json()
      inbound = (Array.isArray(data.messages) ? data.messages : [])
        .filter((m) => !m.is_from_me && m.timestamp != null)
        .map((m) => APPLE_EPOCH + Number(m.timestamp))
        .filter((ms) => Number.isFinite(ms))
        .sort((a, b) => a - b)
    } catch {
      sidecarFails++
      continue // skip this contact; next run retries
    }

    // a reply credits the latest sent touch before it → cap each touch's
    // window at the next sent touch to the same contact
    phoneTouches.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at))
    for (let i = 0; i < phoneTouches.length; i++) {
      const t = phoneTouches[i]
      checked++
      const sentMs = new Date(t.occurred_at).getTime()
      const nextMs = i + 1 < phoneTouches.length
        ? new Date(phoneTouches[i + 1].occurred_at).getTime()
        : Infinity
      const windowEnd = Math.min(sentMs + WINDOW_MS, nextMs)
      const reply = inbound.find((ms) => ms > sentMs && ms <= windowEnd)
      const repliedAt = reply ? new Date(reply).toISOString() : null
      if (repliedAt) withReply++
      const current = t.replied_at ? new Date(t.replied_at).toISOString() : null
      if (repliedAt !== current) updates.push({ id: t.id, replied_at: repliedAt })
    }
  }

  const replyRate = checked ? ((withReply / checked) * 100).toFixed(1) : "0.0"
  console.log(`contacts:        ${byPhone.size}`)
  console.log(`touches checked: ${checked}  (${noPhone} skipped — no phone)`)
  console.log(`got a reply:     ${withReply}  (${replyRate}%)`)
  console.log(`changed:         ${updates.length}${sidecarFails ? `   ⚠ ${sidecarFails} sidecar failures` : ""}`)

  if (DRY_RUN) {
    console.log("— dry run — no writes. Re-run without --dry-run to apply.")
    return
  }

  let updated = 0
  for (const u of updates) {
    const { error } = await supabase
      .from("relationship_touches")
      .update({ replied_at: u.replied_at })
      .eq("id", u.id)
    if (error) console.error(`update ${u.id} failed: ${error.message}`)
    else updated++
  }
  console.log(`✓ ${updated} touches updated`)
}

main().catch((e) => { console.error("✗", e.message); process.exit(1) })
