#!/usr/bin/env node
/**
 * Agent email-drip campaign engine (Phase 3 of
 * briefs/EMAIL_DRIP_CAMPAIGN_2026-07-17.md). Runs on the Mac mini via
 * launchd (same pattern as drip-engine.js).
 *
 *   node scripts/campaign-engine.mjs [--draft] [--send] [--dry-run]
 *        [--limit=N] [--now] [--to=email]
 *
 * No mode flags → both passes (draft, then send).
 *
 * DRAFT pass: finds active contacts whose next_touch_at is due, re-checks
 *   the master suppression list live, renders the touch template, and
 *   inserts campaign_sends rows as status 'draft'. NOTHING auto-sends:
 *   every draft waits for Ryan's approval in the /campaign queue
 *   (training-wheels rule — per-touch auto-send can come later).
 *   Daily draft cap keeps the review queue reviewable.
 *
 * SEND pass: sends status 'approved' rows via the Gmail API as
 *   info@lrghomes.com (service account + DWD), inside the 9:00a–4:30p PT
 *   window (--now overrides for testing), up to the daily send cap, with
 *   randomized 3–10s jitter between sends. Stamps gmail ids, advances the
 *   contact's touch clock, and re-checks contact status + suppression at
 *   send time. Failures mark the row 'failed' and alert Telegram — no
 *   silent skips anywhere.
 *
 * --to=email (with --send) redirects every send to that address — the
 *   live end-to-end test mode from the brief's verification plan.
 *
 * Safety checks (never bypassable): suppression, contact status,
 * daily cap, send window
 * (--now excepted), touch-10 placeholder refusal.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { google } from "googleapis"
import { TOUCHES, renderTouch, nextOffsetDays } from "./campaign-touches.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

// ---------- env ----------
for (const line of fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf-8").split(/\r?\n/)) {
  const eq = line.indexOf("=")
  if (eq < 0 || line.trim().startsWith("#")) continue
  const key = line.slice(0, eq).trim()
  let val = line.slice(eq + 1).trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
  if (process.env[key] === undefined) process.env[key] = val
}

const SEND_AS = process.env.CAMPAIGN_SEND_AS || "info@lrghomes.com"
const DRAFT_DAILY_CAP = Number(process.env.CAMPAIGN_DRAFT_CAP || 200)
const SEND_DAILY_CAP = Number(process.env.CAMPAIGN_SEND_CAP || 200)
const WINDOW = { startHour: 9, endHour: 16.5 } // America/Los_Angeles, Mon-Fri (Ryan 2026-07-20)

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
})

// ---------- args ----------
const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const nowOverride = args.includes("--now")
const doDraft = args.includes("--draft") || (!args.includes("--send") && !args.includes("--draft"))
const doSend = args.includes("--send") || (!args.includes("--send") && !args.includes("--draft"))
const limitArg = args.find((a) => a.startsWith("--limit="))
const limit = limitArg ? Number(limitArg.split("=")[1]) : null
const toArg = args.find((a) => a.startsWith("--to="))
const redirectTo = toArg ? toArg.split("=")[1] : null

// ---------- helpers ----------
function log(msg) {
  console.log(`[campaign] ${msg}`)
}

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    })
  } catch (e) {
    console.warn("[campaign] telegram alert failed:", e?.message)
  }
}

function laWeekdayNow() {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(new Date())
}

function laHourNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date())
  const h = Number(parts.find((p) => p.type === "hour").value)
  const m = Number(parts.find((p) => p.type === "minute").value)
  return h + m / 60
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchSuppressionSets() {
  const emails = new Set()
  const phones = new Set()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("suppression")
      .select("email, phone")
      .in("channel", ["email", "all"])
      .range(from, from + 999)
    if (error) throw new Error(`suppression fetch: ${error.message}`)
    for (const r of data) {
      if (r.email) emails.add(r.email)
      if (r.phone) phones.add(r.phone)
    }
    if (data.length < 1000) break
  }
  return { emails, phones }
}

function isSuppressed(contact, sets) {
  return (contact.email && sets.emails.has(contact.email)) || (contact.phone && sets.phones.has(contact.phone))
}

async function countToday(table, tsCol, filters) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  let q = sb.from(table).select("id", { count: "exact", head: true }).gte(tsCol, start.toISOString())
  for (const [k, v] of Object.entries(filters ?? {})) q = q.in(k, v)
  const { count, error } = await q
  if (error) throw new Error(`count ${table}: ${error.message}`)
  return count ?? 0
}

// ---------- DRAFT pass ----------
async function draftPass() {
  const sets = await fetchSuppressionSets()
  const draftedToday = await countToday("campaign_sends", "created_at")
  let budget = Math.max(0, DRAFT_DAILY_CAP - draftedToday)
  if (limit !== null) budget = Math.min(budget, limit)
  log(`draft pass: ${draftedToday} drafted today, budget ${budget}`)
  if (budget === 0) return

  const { data: due, error } = await sb
    .from("campaign_contacts")
    .select("id, name, first_name, email, phone, status, touch_number, next_touch_at")
    .eq("status", "active")
    .not("email", "is", null)
    .lte("next_touch_at", new Date().toISOString())
    .order("next_touch_at", { ascending: true })
    .limit(budget * 2) // headroom for skips
  if (error) throw new Error(`due fetch: ${error.message}`)

  let drafted = 0
  let skippedSupp = 0
  for (const c of due) {
    if (drafted >= budget) break
    if (isSuppressed(c, sets)) {
      skippedSupp++
      if (!dryRun) {
        await sb.from("campaign_contacts").update({ status: "suppressed", updated_at: new Date().toISOString() }).eq("id", c.id)
      }
      continue
    }
    const touch = c.touch_number + 1
    const rendered = renderTouch(touch, c)
    if (!rendered) {
      // sequence complete — park the contact
      if (!dryRun) await sb.from("campaign_contacts").update({ status: "paused", next_touch_at: null }).eq("id", c.id)
      continue
    }
    if (rendered.placeholder) {
      log(`touch ${touch} is a placeholder (${rendered.label}) — skipping ${c.email} until copy is written`)
      continue
    }
    if (dryRun) {
      log(`would draft T${touch} → ${c.name} <${c.email}> "${rendered.subject}"`)
      drafted++
      continue
    }
    const { error: insErr } = await sb.from("campaign_sends").insert({
      contact_id: c.id,
      touch_number: touch,
      subject: rendered.subject,
      body: rendered.body,
      status: "draft",
    })
    if (insErr) {
      if (/duplicate key/i.test(insErr.message)) continue // draft already pending — engine re-run
      throw new Error(`draft insert (${c.email}): ${insErr.message}`)
    }
    drafted++
  }
  log(`draft pass done: ${drafted} drafted, ${skippedSupp} newly suppressed`)
  if (drafted > 0 && !dryRun) {
    await telegram(`📝 Campaign: <b>${drafted}</b> new drafts ready for review in /campaign`)
  }
}

// ---------- SEND pass ----------
function buildMime({ from, to, subject, body }) {
  const headers = [
    `From: Ryan LaRocca <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ]
  return `${headers.join("\r\n")}\r\n\r\n${body}`
}

function b64url(s) {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function gmailClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY)
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    subject: SEND_AS,
  })
  await auth.authorize()
  return google.gmail({ version: "v1", auth })
}

async function sendPass() {
  // Postal-address gate removed 2026-07-18 by Ryan's explicit call (list is
  // known colleagues; he accepts the CAN-SPAM exposure — advised, decision
  // logged in the brief). The opt-out line in every signature stays.
  const weekday = laWeekdayNow()
  if (!nowOverride && (weekday === "Sat" || weekday === "Sun")) {
    log(`weekend (${weekday}) — sends hold until Monday 9:00a PT`)
    return
  }
  const hour = laHourNow()
  if (!nowOverride && (hour < WINDOW.startHour || hour > WINDOW.endHour)) {
    log(`outside send window (${hour.toFixed(2)}h PT) — skipping send pass`)
    return
  }
  const sentToday = await countToday("campaign_sends", "sent_at", { status: ["sent"] })
  let budget = Math.max(0, SEND_DAILY_CAP - sentToday)
  if (limit !== null) budget = Math.min(budget, limit)
  log(`send pass: ${sentToday} sent today, budget ${budget}`)
  if (budget === 0) return

  const { data: approved, error } = await sb
    .from("campaign_sends")
    .select("id, contact_id, touch_number, subject, body, status")
    .eq("status", "approved")
    .order("approved_at", { ascending: true })
    .limit(budget)
  if (error) throw new Error(`approved fetch: ${error.message}`)
  if (approved.length === 0) {
    log("nothing approved to send")
    return
  }

  const sets = await fetchSuppressionSets()
  const gmail = dryRun ? null : await gmailClient()
  let sent = 0
  let failed = 0
  for (const row of approved) {
    const { data: contact, error: cErr } = await sb
      .from("campaign_contacts")
      .select("id, name, first_name, email, phone, status, touch_number, gmail_thread_id")
      .eq("id", row.contact_id)
      .single()
    if (cErr || !contact) {
      await markFailed(row, `contact fetch failed: ${cErr?.message ?? "missing"}`)
      failed++
      continue
    }
    // Send-time safety re-checks
    if (contact.status !== "active" || isSuppressed(contact, sets)) {
      if (!dryRun) await sb.from("campaign_sends").update({ status: "skipped", error: `contact ${contact.status}${isSuppressed(contact, sets) ? " + suppressed" : ""} at send time` }).eq("id", row.id)
      log(`skipped ${contact.email}: ${contact.status}/suppression at send time`)
      continue
    }
    const to = redirectTo ?? contact.email
    if (dryRun) {
      log(`would send T${row.touch_number} → ${to} "${row.subject}"`)
      sent++
      continue
    }
    try {
      const raw = b64url(buildMime({ from: SEND_AS, to, subject: row.subject, body: row.body }))
      const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } })
      const msg = res.data
      const nowIso = new Date().toISOString()
      await sb.from("campaign_sends").update({
        status: "sent",
        sent_at: nowIso,
        gmail_message_id: msg.id ?? null,
        gmail_thread_id: msg.threadId ?? null,
      }).eq("id", row.id)
      const offset = nextOffsetDays(row.touch_number)
      await sb.from("campaign_contacts").update({
        touch_number: row.touch_number,
        last_sent_at: nowIso,
        gmail_thread_id: msg.threadId ?? contact.gmail_thread_id,
        next_touch_at: offset === null ? null : new Date(Date.now() + offset * 86_400_000).toISOString(),
        updated_at: nowIso,
      }).eq("id", contact.id)
      await sb.from("campaign_events").insert({
        contact_id: contact.id,
        kind: "email_out",
        body: `T${row.touch_number}: ${row.subject}`,
        occurred_at: nowIso,
      })
      sent++
      log(`sent T${row.touch_number} → ${to}`)
    } catch (e) {
      await markFailed(row, e?.message ?? String(e))
      failed++
    }
    await sleep(3000 + Math.random() * 7000)
  }
  log(`send pass done: ${sent} sent, ${failed} failed`)
  if (failed > 0) await telegram(`⚠️ Campaign: <b>${failed}</b> send failures this pass — check campaign_sends.error`)
}

async function markFailed(row, err) {
  log(`FAILED send ${row.id}: ${err}`)
  if (!dryRun) await sb.from("campaign_sends").update({ status: "failed", error: err }).eq("id", row.id)
}

// ---------- main ----------
try {
  if (doDraft) await draftPass()
  if (doSend) await sendPass()
} catch (e) {
  console.error("[campaign] engine error:", e?.message ?? e)
  await telegram(`🔥 Campaign engine crashed: ${e?.message ?? e}`)
  process.exit(1)
}
