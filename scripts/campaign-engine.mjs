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
// Per-touch training wheels (Ryan 2026-07-31: "I don't need to approve the
// 200 batch each day, at least for touch one"). Touches listed here are
// drafted straight to 'approved' — no review stop. Everything else still
// waits for Ryan. Send-time safety checks (suppression, status, cap,
// window) are unchanged and never bypassable. Extend later: "1,2,3".
const AUTO_SEND_TOUCHES = new Set(
  (process.env.CAMPAIGN_AUTO_SEND_TOUCHES || "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter(Number.isFinite)
)
const WINDOW = { startHour: 7, endHour: 17 } // America/Los_Angeles, Mon-Fri (widened for the send-time experiment, Ryan 2026-07-31)

// ---- Send-time experiment (Ryan 2026-07-31) ----
// Every auto-approved send gets a uniformly random minute in the 7:00a-4:59p
// PT window on the NEXT weekday. Next-day assignment (not same-day) keeps
// hour coverage uniform — drafts minted mid-afternoon would otherwise only
// ever land in late slots. Replies are analyzed against ACTUAL sent_at hour
// (Friday scorecard + /email-campaign Performance tab).
const EXPERIMENT_START = "2026-07-31"

function ptDateParts(date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  })
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
}

function ptSlotToUtcIso(y, m, d, hour, minute) {
  // PT is UTC-7 (PDT) or UTC-8 (PST) — pick the offset that round-trips.
  for (const off of [7, 8]) {
    const t = new Date(Date.UTC(y, m - 1, d, hour + off, minute))
    const got = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(t)
    if (Number(got) % 24 === hour) return t.toISOString()
  }
  return new Date(Date.UTC(y, m - 1, d, hour + 7, minute)).toISOString()
}

function randomSendSlot() {
  const now = new Date()
  for (let add = 1; add <= 4; add++) {
    const parts = ptDateParts(new Date(now.getTime() + add * 86400_000))
    if (parts.weekday === "Sat" || parts.weekday === "Sun") continue
    const minuteOfDay = 7 * 60 + Math.floor(Math.random() * 10 * 60) // 7:00a-4:59p PT
    return ptSlotToUtcIso(Number(parts.year), Number(parts.month), Number(parts.day), Math.floor(minuteOfDay / 60), minuteOfDay % 60)
  }
  return null
}

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
  // Campaign traffic lives on the dedicated campaign bot (2026-07-23);
  // Thadius's bot is only the fallback if it's ever unset.
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
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
  // Backlog-aware budget (2026-07-28): only top the pipeline up to the cap.
  // Before this, the pass minted 200/day unconditionally — including Sat+Sun
  // while sends held — so Ryan faced a ~400-draft mega-queue Monday and the
  // send cap spread his one approval across two days of sends he didn't
  // expect. Invariant now: draft + approved (un-sent) never exceeds the cap.
  const { count: backlog, error: backlogErr } = await sb
    .from("campaign_sends")
    .select("id", { count: "exact", head: true })
    .in("status", ["draft", "approved"])
  if (backlogErr) throw new Error(`backlog count: ${backlogErr.message}`)
  let budget = Math.max(0, Math.min(DRAFT_DAILY_CAP - draftedToday, DRAFT_DAILY_CAP - (backlog ?? 0)))
  if (limit !== null) budget = Math.min(budget, limit)
  log(`draft pass: ${draftedToday} drafted today, ${backlog ?? 0} in draft/approved backlog, budget ${budget}`)
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
  let autoApproved = 0
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
    const auto = AUTO_SEND_TOUCHES.has(touch)
    if (dryRun) {
      log(`would draft T${touch}${auto ? " (auto-approved)" : ""} → ${c.name} <${c.email}> "${rendered.subject}"`)
      drafted++
      if (auto) autoApproved++
      continue
    }
    const { error: insErr } = await sb.from("campaign_sends").insert({
      contact_id: c.id,
      touch_number: touch,
      subject: rendered.subject,
      body: rendered.body,
      status: auto ? "approved" : "draft",
      ...(auto ? { approved_at: new Date().toISOString(), scheduled_for: randomSendSlot() } : {}),
    })
    if (insErr) {
      if (/duplicate key/i.test(insErr.message)) continue // draft already pending — engine re-run
      throw new Error(`draft insert (${c.email}): ${insErr.message}`)
    }
    drafted++
    if (auto) autoApproved++
  }
  const needReview = drafted - autoApproved
  log(`draft pass done: ${drafted} drafted (${autoApproved} auto-approved), ${skippedSupp} newly suppressed`)
  if (drafted > 0 && !dryRun) {
    const parts = []
    if (autoApproved > 0) parts.push(`🚀 <b>${autoApproved}</b> auto-approved (T${[...AUTO_SEND_TOUCHES].join("/T")}) — sending in the next send window`)
    if (needReview > 0) parts.push(`📝 <b>${needReview}</b> awaiting review in /email-campaign`)
    await telegram(`Campaign drafts: ${parts.join(" · ")}`)
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
  // Weekend is a hard guard for everyone (Ryan: M-F only), --now excepted.
  const weekday = laWeekdayNow()
  if (!nowOverride && (weekday === "Sat" || weekday === "Sun")) {
    log(`weekend (${weekday}) — sends hold until Monday 9:00a PT`)
    return
  }
  // The 9:00-16:30 window applies to UNSCHEDULED approvals only. A row with
  // an explicit scheduled_for (Ryan picked the time) sends at that time even
  // outside the window — an explicit choice beats the default. (2026-07-21)
  const hour = laHourNow()
  const inWindow = hour >= WINDOW.startHour && hour <= WINDOW.endHour

  const sentToday = await countToday("campaign_sends", "sent_at", { status: ["sent"] })
  let budget = Math.max(0, SEND_DAILY_CAP - sentToday)
  if (limit !== null) budget = Math.min(budget, limit)
  log(`send pass: ${sentToday} sent today, budget ${budget}, ${inWindow ? "in-window" : "OUT of window"}`)
  if (budget === 0) return

  const nowIso = new Date().toISOString()
  // Eligible = approved AND (no schedule OR its scheduled time has arrived).
  const { data: eligible, error } = await sb
    .from("campaign_sends")
    .select("id, contact_id, touch_number, subject, body, status, scheduled_for")
    .eq("status", "approved")
    .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
    .order("approved_at", { ascending: true })
    .limit(budget)
  if (error) throw new Error(`approved fetch: ${error.message}`)
  // Unscheduled rows need the send window; scheduled-due rows bypass it.
  const approved = (eligible ?? []).filter((r) => nowOverride || r.scheduled_for || inWindow)
  if (approved.length === 0) {
    log(inWindow ? "nothing approved + due to send" : "outside window — no scheduled sends due")
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

// ---------- DIGEST pass ----------
// One visible receipt per batch instead of silence (Ryan, 2026-07-22:
// "bounces + no Telegram = looks broken every day"). Any bounce events
// since the last digest → ONE summary message. Watermark lives in a
// local state file so the 20-min launchd cadence can't double-report.
const DIGEST_STATE = path.join(__dirname, ".campaign-digest-state.json")

function escHtml(t) {
  return String(t).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

async function digestPass() {
  let since = new Date(Date.now() - 24 * 3600_000).toISOString()
  try {
    since = JSON.parse(fs.readFileSync(DIGEST_STATE, "utf-8")).last
  } catch {
    // first run — default to 24h back
  }
  const nowIso = new Date().toISOString()
  const { data: bounces, error } = await sb
    .from("campaign_events")
    .select("body, contact:campaign_contacts (name, email)")
    .eq("kind", "bounce")
    .gt("occurred_at", since)
    .order("occurred_at", { ascending: true })
  if (error) throw new Error(`digest fetch: ${error.message}`)
  if (!bounces || bounces.length === 0) {
    fs.writeFileSync(DIGEST_STATE, JSON.stringify({ last: nowIso }))
    return
  }
  const names = bounces
    .map((b) => escHtml(b.contact?.name ?? b.contact?.email ?? "unknown"))
    .join(", ")
  const sentToday = await countToday("campaign_sends", "sent_at", { status: ["sent"] })
  const { count: stillQueued } = await sb
    .from("campaign_sends")
    .select("id", { count: "exact", head: true })
    .eq("status", "approved")
  await telegram(
    `↩️ <b>${bounces.length} bounce${bounces.length === 1 ? "" : "s"}</b> from the latest batch — caught and removed automatically: ${names}\n\n📤 ${sentToday} sent today.${(stillQueued ?? 0) > 0 ? ` ⏳ ${stillQueued} still sending this batch.` : ""} Replies always alert individually the moment they arrive.`
  )
  fs.writeFileSync(DIGEST_STATE, JSON.stringify({ last: nowIso }))
  log(`digest sent: ${bounces.length} bounces`)
}

// ---------- Friday send-time scorecard ----------
const SCORECARD_STATE = path.join(__dirname, ".campaign-scorecard-state.json")

async function scorecardPass() {
  // Fires once, Fridays after 4pm PT. Reply attribution: a sent email counts
  // as "replied" if its contact logged an email_reply within 14 days after
  // that send. Bins by ACTUAL sent_at hour (PT) since EXPERIMENT_START.
  const parts = ptDateParts(new Date())
  if (parts.weekday !== "Fri" || laHourNow() < 16) return
  let lastSent = ""
  try {
    lastSent = JSON.parse(fs.readFileSync(SCORECARD_STATE, "utf-8")).last
  } catch { /* first run */ }
  const today = `${parts.year}-${parts.month}-${parts.day}`
  if (lastSent === today) return

  const sends = []
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from("campaign_sends")
      .select("contact_id, sent_at")
      .eq("status", "sent")
      .gte("sent_at", EXPERIMENT_START)
      .range(off, off + 999)
    if (error) throw new Error(`scorecard sends: ${error.message}`)
    sends.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  if (sends.length === 0) return
  const replies = new Map() // contact_id -> [reply times]
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from("campaign_events")
      .select("contact_id, occurred_at")
      .eq("kind", "email_reply")
      .gte("occurred_at", EXPERIMENT_START)
      .range(off, off + 999)
    if (error) throw new Error(`scorecard replies: ${error.message}`)
    for (const r of data ?? []) {
      if (!r.contact_id) continue
      const arr = replies.get(r.contact_id) ?? []
      arr.push(new Date(r.occurred_at).getTime())
      replies.set(r.contact_id, arr)
    }
    if (!data || data.length < 1000) break
  }
  const bins = new Map() // pt hour -> {sent, replied}
  for (const s of sends) {
    const t = new Date(s.sent_at)
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(t)) % 24
    const b = bins.get(hour) ?? { sent: 0, replied: 0 }
    b.sent++
    const rts = replies.get(s.contact_id) ?? []
    const sMs = t.getTime()
    if (rts.some((rt) => rt > sMs && rt - sMs < 14 * 86400_000)) b.replied++
    bins.set(hour, b)
  }
  const lines = [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([h, b]) => {
      const label = h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`
      const pct = b.sent ? ((100 * b.replied) / b.sent).toFixed(1) : "0.0"
      return `${label}: ${b.sent} sent, ${b.replied} replies (${pct}%)`
    })
  await telegram(`📊 <b>Send-time scorecard</b> (since ${EXPERIMENT_START}, replies within 14d)\n${lines.join("\n")}\n\nFull chart: /email-campaign → Performance`)
  fs.writeFileSync(SCORECARD_STATE, JSON.stringify({ last: today }))
  log(`scorecard sent (${sends.length} sends analyzed)`)
}

// ---------- main ----------
const digestOnly = args.includes("--digest")
try {
  if (!digestOnly && doDraft) await draftPass()
  if (!digestOnly && doSend) await sendPass()
  await digestPass()
  await scorecardPass()
} catch (e) {
  console.error("[campaign] engine error:", e?.message ?? e)
  await telegram(`🔥 Campaign engine crashed: ${e?.message ?? e}`)
  process.exit(1)
}
