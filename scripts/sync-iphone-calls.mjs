#!/usr/bin/env node
// Sync Ryan's iPhone call log into mission-control (Ryan 2026-10-26: "I want
// you to be able to see my call logs and how long I was on the phone with
// each person").
//
// The iPhone shares its call history with the Mac mini ("Calls on Other
// Devices" on the phone + "Calls from iPhone" in FaceTime on the Mac). macOS
// keeps it in ~/Library/Application Support/CallHistoryDB/CallHistory.storedata
// — a Full Disk Access file, so this must run under launchd with
// /opt/homebrew/bin/node (the binary that holds FDA), never from a terminal.
//
// Each run:
//   1. Mirrors the last --days of calls into `phone_calls` (one row per call).
//   2. For every call not yet processed, classifies + logs it onto the card:
//        - from/to one of our Twilio lines → the leg of a system call
//          (click-to-call rings Ryan's cell FROM a Twilio line; forwarded
//          inbound calls show the line too). Already logged — skip.
//        - Relationships contact → relationship_touches row (modality=call),
//          last_contacted_at bumped when the call connected.
//        - Leads contact → a leads row (lead_type=call). Outgoing = null
//          twilio_number (the outbound convention); incoming = "iphone"
//          marker (non-null → inbound, and resolveReplyLine skips anything
//          that isn't a "+" number, same as the "email:" marker).
//        - Neither → kind=unknown, stored only.
//      A system call row for the same number within ±5 min wins (never log a
//      call twice). Calls before --cards-since are classified but never
//      written to cards (no retroactive card history without Ryan's go).
//
// Usage:
//   node scripts/sync-iphone-calls.mjs                 # dry-run, last 2 days
//   node scripts/sync-iphone-calls.mjs --execute
//   node scripts/sync-iphone-calls.mjs --execute --days=31
//
// Failures (can't read the call log, Twilio lookup, DB writes, call log gone
// stale) post a Telegram alert, throttled to one per kind per 6h.

import { createClient } from "@supabase/supabase-js"
import { DatabaseSync } from "node:sqlite"
import { readFileSync, writeFileSync, statSync } from "node:fs"
import { homedir } from "node:os"

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) {
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}

const args = process.argv.slice(2)
const execute = args.includes("--execute")
const arg = (name, dflt) => args.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? dflt
const days = parseInt(arg("days", "2"), 10)
// Card logging went live 2026-10-26 (start of day, Pacific).
const cardsSinceMs = new Date(arg("cards-since", "2026-10-26T07:00:00Z")).getTime()

const CALL_DB = `${homedir()}/Library/Application Support/CallHistoryDB/CallHistory.storedata`
const RYAN_CELL = "+14085006293" // lib/leads.ts FORWARD_TO
const DEDUPE_MS = 5 * 60 * 1000
const STALE_MS = 72 * 60 * 60 * 1000
const APPLE_EPOCH_S = 978307200

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)

async function alert(key, text) {
  const stamp = `/tmp/lrg-iphone-calls-alert-${key}`
  try { if (Date.now() - statSync(stamp).mtimeMs < 6 * 60 * 60 * 1000) return } catch {}
  writeFileSync(stamp, new Date().toISOString())
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!execute || !token || !chat) { console.error(`[alert:${key}] ${text}`); return }
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: `📱 iPhone call sync: ${text}` }),
  }).catch(() => {})
}

function toE164(raw) {
  const s = String(raw ?? "").trim()
  if (!s || s.includes("@")) return null
  const d = s.replace(/\D/g, "")
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith("1")) return `+${d}`
  if (s.startsWith("+") && d.length >= 8 && d.length <= 15) return `+${d}`
  return null
}

function fmtDur(sec) {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60), s = sec % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

function callMessage(c) {
  const connected = c.duration_sec > 0
  if (c.direction === "outgoing") {
    return connected ? `📱 Called from iPhone · ${fmtDur(c.duration_sec)} (not recorded)` : "📵 Called from iPhone · no answer"
  }
  return connected ? `📱 They called your iPhone · ${fmtDur(c.duration_sec)} (not recorded)` : "📵 Missed call on your iPhone"
}

// ── 1. Read the call log ─────────────────────────────────────────────────────
let records
try {
  const db = new DatabaseSync(CALL_DB, { readOnly: true })
  const sinceApple = Date.now() / 1000 - days * 86400 - APPLE_EPOCH_S
  records = db.prepare(`
    SELECT ZUNIQUE_ID AS id, ZDATE AS d, ZADDRESS AS address, ZDURATION AS dur,
           ZORIGINATED AS originated, ZANSWERED AS answered, ZSERVICE_PROVIDER AS service
    FROM ZCALLRECORD WHERE ZDATE >= ? ORDER BY ZDATE`).all(sinceApple)
  const newest = db.prepare(`SELECT MAX(ZDATE) AS d FROM ZCALLRECORD`).get()?.d
  db.close()
  if (newest == null || (newest + APPLE_EPOCH_S) * 1000 < Date.now() - STALE_MS) {
    await alert("stale", "no new iPhone calls have reached the Mac mini in 3+ days — check Settings → Apps → Phone → Calls on Other Devices still has the Mac mini switched on.")
  }
} catch (e) {
  await alert("read", `can't read the iPhone call log on the Mac mini (${e.message}). Calls from your phone aren't being logged to cards.`)
  console.error(e)
  process.exit(1)
}

const rows = records
  .filter(r => r.id)
  .map(r => ({
    id: String(r.id),
    occurred_at: new Date((r.d + APPLE_EPOCH_S) * 1000).toISOString(),
    phone: toE164(r.address) ?? (r.address ? String(r.address) : null),
    direction: r.originated ? "outgoing" : "incoming",
    answered: !!r.answered,
    duration_sec: Math.max(0, Math.round(r.dur || 0)),
    service: r.service ?? null,
  }))
console.log(`Mode: ${execute ? "EXECUTE" : "DRY-RUN"}    ${rows.length} call(s) in the last ${days}d`)

// ── 2. Mirror into phone_calls (new rows only) ───────────────────────────────
if (execute && rows.length) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("phone_calls").upsert(rows.slice(i, i + 500), { onConflict: "id", ignoreDuplicates: true })
    if (error) { await alert("db", `couldn't save calls (${error.message})`); console.error(error); process.exit(1) }
  }
}

let pending
if (execute) {
  const { data, error } = await sb.from("phone_calls").select("*").is("processed_at", null).order("occurred_at").limit(1000)
  if (error) { await alert("db", `couldn't read pending calls (${error.message})`); process.exit(1) }
  pending = data ?? []
} else {
  const ids = rows.map(r => r.id)
  const seen = new Set()
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("phone_calls").select("id").in("id", ids.slice(i, i + 200)).not("processed_at", "is", null)
    for (const r of data ?? []) seen.add(r.id)
  }
  pending = rows.filter(r => !seen.has(r.id))
}
if (!pending.length) { console.log("Nothing new."); process.exit(0) }

// Our Twilio lines — authoritative list from the account.
const owned = new Set([RYAN_CELL])
try {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")
  let url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PageSize=200`
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } })
    if (!r.ok) throw new Error(`Twilio ${r.status}`)
    const body = await r.json()
    for (const n of body.incoming_phone_numbers ?? []) owned.add(n.phone_number)
    url = body.next_page_uri ? `https://api.twilio.com${body.next_page_uri}` : null
  }
  if (owned.size < 3) throw new Error(`only ${owned.size - 1} Twilio number(s) returned`)
} catch (e) {
  // Without the list, system-call legs would be logged a second time — stop.
  await alert("twilio", `couldn't load our Twilio numbers (${e.message}); call sync paused until it can.`)
  process.exit(1)
}

// ── 3. Classify + log each new call ──────────────────────────────────────────
const windowOf = c => {
  const t = new Date(c.occurred_at).getTime()
  return [new Date(t - DEDUPE_MS).toISOString(), new Date(t + DEDUPE_MS).toISOString()]
}

async function findRelationship(e164) {
  const d = e164.replace(/\D/g, "").slice(-10)
  const { data, error } = await sb.from("relationships")
    .select("id, name, tier, category, last_contacted_at")
    .or(`phone.like.%${d},alt_phones.cs.{+1${d}}`)
    .order("status", { ascending: true })
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

async function findLeadCluster(e164) {
  const { data, error } = await sb.from("leads")
    .select("source, source_type, drip_campaign_type, status, name, email, property_address, is_junk")
    .eq("caller_phone", e164)
    .order("created_at", { ascending: false })
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

let logged = 0, failed = 0
for (const c of pending) {
  const t = new Date(c.occurred_at).getTime()
  const upd = { processed_at: new Date().toISOString(), kind: "unknown", skip_reason: null }
  const e164 = toE164(c.phone)
  const lines = []
  try {
    if (!e164) { upd.kind = "skipped"; upd.skip_reason = "no phone number (FaceTime/email address)" }
    else if (owned.has(e164)) {
      upd.kind = "business_line"
      upd.skip_reason = c.direction === "incoming" ? "leg of a system call — already logged" : "Ryan dialed one of our own lines"
    }
    else {
      const [rel, lead] = await Promise.all([findRelationship(e164), findLeadCluster(e164)])
      const useLead = lead && !lead.is_junk
      if (rel) { upd.relationship_id = rel.id; upd.relationship_category = rel.category ?? null }
      if (useLead) upd.lead_cluster_phone = e164
      upd.kind = rel && useLead ? "both" : rel ? "relationship" : useLead ? "lead" : "unknown"
      const writeCards = t >= cardsSinceMs
      if (!writeCards && upd.kind !== "unknown") upd.skip_reason = "before card logging started"
      const [lo, hi] = windowOf(c)
      const message = callMessage(c)
      const connected = c.duration_sec > 0

      if (rel && writeCards) {
        const { data: dup } = await sb.from("relationship_touches").select("id")
          .eq("relationship_id", rel.id).eq("modality", "call").gte("occurred_at", lo).lte("occurred_at", hi).limit(1)
        if (dup?.length) lines.push(`rel ${rel.name}: system call already logged`)
        else if (!execute) lines.push(`rel ${rel.name}: would log "${message}"`)
        else {
          const { data: touch, error } = await sb.from("relationship_touches").insert({
            relationship_id: rel.id,
            occurred_at: c.occurred_at,
            modality: "call",
            action: c.direction === "outgoing" ? "call" : "inbound",
            message,
            call_status: connected ? "completed" : "no-answer",
            call_duration_sec: c.duration_sec,
            tier_at_touch: rel.tier ?? null,
            category_at_touch: rel.category ?? null,
          }).select("id").single()
          if (error) throw error
          upd.touch_id = touch.id
          if (connected && (!rel.last_contacted_at || new Date(rel.last_contacted_at).getTime() < t)) {
            const { error: lcErr } = await sb.from("relationships").update({ last_contacted_at: c.occurred_at }).eq("id", rel.id)
            if (lcErr) throw lcErr
          }
          lines.push(`rel ${rel.name}: logged`)
        }
      }

      if (useLead && writeCards) {
        const { data: dup } = await sb.from("leads").select("id")
          .eq("caller_phone", e164).in("lead_type", ["call", "voicemail"]).gte("created_at", lo).lte("created_at", hi).limit(1)
        if (dup?.length) lines.push(`lead ${lead.name || e164}: system call already logged`)
        else if (!execute) lines.push(`lead ${lead.name || e164}: would log "${message}"`)
        else {
          const row = {
            source: lead.source,
            source_type: lead.source_type,
            twilio_number: c.direction === "outgoing" ? null : "iphone",
            caller_phone: e164,
            lead_type: "call",
            message,
            status: lead.status || "contacted",
            name: lead.name,
            email: lead.email,
            property_address: lead.property_address,
            created_at: c.occurred_at,
          }
          if (lead.drip_campaign_type) row.drip_campaign_type = lead.drip_campaign_type
          const { data: ins, error } = await sb.from("leads").insert(row).select("id").single()
          if (error) throw error
          upd.lead_row_id = ins.id
          lines.push(`lead ${lead.name || e164}: logged`)
        }
      }
    }
    if (execute) {
      const { error } = await sb.from("phone_calls").update(upd).eq("id", c.id)
      if (error) throw error
    }
    if (upd.touch_id || upd.lead_row_id) logged++
  } catch (e) {
    failed++
    console.error(`✗ ${c.id}`, e)
    await alert("db", `couldn't log a ${c.direction} call with ${c.phone} (${e.message ?? e}).`)
  }
  const local = new Date(c.occurred_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
  console.log(`${local}  ${c.direction.padEnd(8)} ${String(c.phone).padEnd(14)} ${fmtDur(c.duration_sec).padStart(8)}  ${upd.kind}${upd.skip_reason ? ` (${upd.skip_reason})` : ""}${lines.length ? "  → " + lines.join("; ") : ""}`)
}
console.log(`\nDone. ${pending.length} processed, ${logged} logged to cards, ${failed} failed.`)
