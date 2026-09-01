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
import { gmailClientFor, sendCampaignMessage } from "./campaign-gmail.mjs"
import { composeVariantBody, lintBody, bodyHash, loadEditExamples, loadCopyRules, PROMPT_VERSION } from "./campaign-compose.mjs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
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
// Doubling ramp (Ryan 2026-08-21: "one, then two, then four... around 200 max"):
// the live cap = RAMP_SCHEDULE[step]; step lives in campaign_settings
// ("ramp"), advances only after a GREEN send day (health pass), holds on
// yellow, drops one step on red. CAMPAIGN_SEND_CAP/DRAFT_CAP are ceilings.
const RAMP_SCHEDULE = (process.env.CAMPAIGN_RAMP_SCHEDULE || "1,2,4,8,16,32,64,128,200").split(",").map(Number)
let DRAFT_DAILY_CAP = Number(process.env.CAMPAIGN_DRAFT_CAP || 200)
let SEND_DAILY_CAP = Number(process.env.CAMPAIGN_SEND_CAP || 200)
let RAMP = { step: 0 }
// Phase B (2026-08-21): while CAMPAIGN_COHORT is set, the draft pass only
// considers contacts tagged with that cohort (scripts/phaseB-cohort.mjs).
const COHORT = process.env.CAMPAIGN_COHORT || null
// Gated batches mint in the EVENING for the next weekday (Ryan: "I might be
// asleep in the morning — I'd rather approve the day before").
const MINT_HOUR = Number(process.env.CAMPAIGN_MINT_HOUR || 18)
const BOUNCE_PAUSE_RATE = 0.02
const REVIEW_URL = "https://mission-control-three-chi.vercel.app/email-campaign"
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

async function telegram(text, buttons) {
  // Campaign traffic lives on the dedicated campaign bot (2026-07-23);
  // Thadius's bot is only the fallback if it's ever unset.
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return
  const reply_markup = buttons?.length ? { inline_keyboard: [buttons] } : undefined
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...(reply_markup ? { reply_markup } : {}) }),
    })
    // Telegram rejects silently otherwise (bad HTML, bad button URL) — Ryan
    // missed a batch ping 2026-08-25 and there was nothing in the log.
    if (!res.ok) console.warn(`[campaign] telegram alert REJECTED ${res.status}: ${(await res.text()).slice(0, 200)} :: ${text.slice(0, 80)}`)
    else log(`telegram sent: ${text.replace(/<[^>]+>/g, "").split("\n")[0].slice(0, 70)}`)
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
// Gated (non-auto) touches mint ONCE per day in a single batch → one review
// ping, not a drip of them every 20 minutes (Ryan 2026-07-31: T2 approval
// gate discussion). Auto touches top up continuously and silently.
const GATED_DRAFT_STATE = path.join(__dirname, ".campaign-gated-draft-state.json")

function ptToday() {
  const p = ptDateParts(new Date())
  return `${p.year}-${p.month}-${p.day}`
}

function gatedMintAllowedToday() {
  if (args.includes("--mint-now")) return true // rehearsal flag (use with --dry-run)
  if (laHourNow() < MINT_HOUR) return false // batch mints on the first pass after MINT_HOUR PT (evening, for the next weekday)
  const wd = laWeekdayNow()
  if (wd === "Fri" || wd === "Sat") return false // Fri/Sat evening batches would sit 2-3 days; Sunday evening mints Monday's
  const p = ptDateParts(new Date())
  const today = `${p.year}-${p.month}-${p.day}`
  try {
    if (JSON.parse(fs.readFileSync(GATED_DRAFT_STATE, "utf-8")).last === today) return false
  } catch { /* first run */ }
  return true
}

function markGatedMinted() {
  const p = ptDateParts(new Date())
  fs.writeFileSync(GATED_DRAFT_STATE, JSON.stringify({ last: `${p.year}-${p.month}-${p.day}` }))
}

async function draftPass() {
  const sets = await fetchSuppressionSets()
  const gatedAllowed = gatedMintAllowedToday()
  // Expire earlier un-tapped batch(es) BEFORE the backlog count — a batch
  // Ryan never approved must not linger (and send later by surprise), nor
  // block tonight's mint by filling the cap. (Bug found 2026-08-21: the 195
  // stale Aug-6 T2 drafts zeroed the budget.)
  if (gatedAllowed && !dryRun) {
    const { data: stale } = await sb.from("campaign_sends").select("id").eq("status", "draft").or(`batch_date.is.null,batch_date.lt.${ptToday()}`)
    if (stale?.length) {
      await sb.from("campaign_sends").update({ status: "expired", error: "batch not approved by next mint" }).in("id", stale.map((r) => r.id))
      log(`expired ${stale.length} un-approved drafts from earlier batches`)
    }
  }
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
  if (budget === 0) {
    // Starved-by-backlog with nothing drafted = the send side is stuck.
    // This exact state ran silently for 4 days after the Aug-28 token death
    // (8 unsendable approved rows filled the cap, so zero drafts minted).
    // Alert once per day instead of quietly returning.
    if (draftedToday === 0 && (backlog ?? 0) >= DRAFT_DAILY_CAP) {
      const starveFile = "scripts/.campaign-draft-starved-state.json"
      const day = new Date().toLocaleDateString("en-CA")
      let last = null
      try { last = JSON.parse(fs.readFileSync(starveFile, "utf-8")).last } catch {}
      if (last !== day) {
        fs.writeFileSync(starveFile, JSON.stringify({ last: day }))
        await telegram(`⚠️ Campaign drafts starved: ${backlog} un-sent draft/approved rows fill the ${DRAFT_DAILY_CAP}/day cap — check the send pass.`)
      }
    }
    return
  }

  let dueQuery = sb
    .from("campaign_contacts")
    .select("id, name, first_name, email, phone, status, touch_number, next_touch_at, cohort, variant, property_address, import_flags")
    .eq("status", "active")
    .not("email", "is", null)
    .lte("next_touch_at", new Date().toISOString())
  if (COHORT) dueQuery = dueQuery.eq("cohort", COHORT) // Phase B: only tagged contacts
  const { data: due, error } = await dueQuery.order("next_touch_at", { ascending: true }).limit(budget * 2) // headroom for skips
  if (error) throw new Error(`due fetch: ${error.message}`)
  const dueList = due ?? []
  // Variant templates (A/B/C) for cohort T1 sends.
  const { data: variantRows } = await sb.from("campaign_variants").select("variant, touch_number, subject, body, personalize")
  const variants = new Map((variantRows ?? []).map((v) => [`${v.touch_number}:${v.variant}`, v]))
  // Ryan's recent draft edits (style examples for the compose prompt), per touch.
  const editExamples = new Map()
  // Ryan's standing copy rules (typed in the queue UI) — one fetch per pass.
  const copyRules = await loadCopyRules(sb)
  const composedThisPass = new Map() // variant → bodies minted this pass (passed as "avoid" for variety)

  // Live copy from the DB (Telegram copy: edits land there); file is fallback.
  const { data: tmplRows, error: tmplErr } = await sb
    .from("campaign_templates")
    .select("touch_number, label, subject, body")
  if (tmplErr) throw new Error(`templates fetch: ${tmplErr.message}`)
  const templates = new Map((tmplRows ?? []).map((t) => [t.touch_number, t]))

  let drafted = 0
  let autoApproved = 0
  let skippedSupp = 0
  const gatedTouches = new Set()
  let lintFailed = 0
  const variantCounts = {}
  for (const c of dueList) {
    if (drafted >= budget) break
    if (isSuppressed(c, sets)) {
      skippedSupp++
      if (!dryRun) {
        await sb.from("campaign_contacts").update({ status: "suppressed", updated_at: new Date().toISOString() }).eq("id", c.id)
      }
      continue
    }
    const touch = c.touch_number + 1
    const rendered = renderTouch(touch, c, templates)
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
    if (!auto && !gatedAllowed) continue // gated touches mint once daily, first pass after MINT_HOUR PT
    if (!auto) gatedTouches.add(touch)
    // Phase B: cohort contacts with a variant get a UNIQUE Claude-composed
    // body from the variant template, hard-linted before it can be queued.
    let variant = null
    let composed = null
    const vt = c.variant ? variants.get(`${touch}:${c.variant}`) : null
    if (vt) {
      try {
        if (!editExamples.has(touch)) editExamples.set(touch, await loadEditExamples(sb, touch))
        composed = await composeVariantBody({ variant: vt, contact: c, seed: `${c.id.slice(0, 8)}-${Date.now() % 100000}`, examples: editExamples.get(touch), avoid: composedThisPass.get(c.variant) ?? [], rules: copyRules })
        composedThisPass.set(c.variant, [...(composedThisPass.get(c.variant) ?? []), composed.body])
        const errs = lintBody({ subject: composed.subject, body: composed.body, firstName: composed.firstName, contact: c })
        if (errs.length) throw new Error(`lint: ${errs.join("; ")}`)
        variant = c.variant
      } catch (e) {
        lintFailed++
        log(`REJECTED draft for ${c.email} (variant ${c.variant}): ${e?.message ?? e}`)
        continue
      }
    }
    const finalSubject = (composed?.subject ?? rendered.subject).trim()
    const finalBody = composed?.body ?? rendered.body
    // Deterministic (non-variant) drafts used to bypass lint entirely — the
    // fallback T1 template shipped a banned relationship claim unchecked.
    // Run the dangerous checks (false history, unfilled merge tokens) on
    // every body; structural checks (greeting/sig lines) stay variant-only
    // because template renders add some pieces later in the send path.
    if (!composed) {
      const detErrs = lintBody({ subject: finalSubject, body: finalBody, firstName: c.first_name || c.name || "", contact: c })
        .filter((m) => m.startsWith("claims a relationship") || m === "unfilled merge token")
      if (detErrs.length) {
        lintFailed++
        log(`REJECTED draft for ${c.email} (template T${touch}): ${detErrs.join("; ")}`)
        continue
      }
    }
    if (variant) variantCounts[variant] = (variantCounts[variant] || 0) + 1
    if (dryRun) {
      log(`would draft T${touch}${auto ? " (auto-approved)" : ""} → ${c.name} <${c.email}> "${finalSubject}"${variant ? ` [${variant} ${PROMPT_VERSION}]` : ""}`)
      if (composed) log(finalBody.split("\n").map((l) => "    | " + l).join("\n"))
      drafted++
      if (auto) autoApproved++
      continue
    }
    const { error: insErr } = await sb.from("campaign_sends").insert({
      contact_id: c.id,
      touch_number: touch,
      subject: finalSubject,
      body: finalBody,
      variant,
      body_hash: bodyHash(finalBody),
      prompt_version: variant ? PROMPT_VERSION : null,
      batch_date: ptToday(),
      sender: SEND_AS,
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
  log(`draft pass done: ${drafted} drafted (${autoApproved} auto-approved, ${needReview} gated), ${skippedSupp} newly suppressed, ${lintFailed} rejected by lint`)
  if (lintFailed && !dryRun) bumpHealthCounter("lint_rejected", lintFailed)
  if (gatedAllowed && !dryRun) markGatedMinted()
  // Auto-approved minting is silent — the tick is machinery Ryan never
  // feels; sends show up in the daily digest. Only a GATED batch pings,
  // once a day, because that one needs his review.
  if (needReview > 0 && !dryRun) {
    const touchList = [...gatedTouches].sort((a, b) => a - b).map((t) => `T${t}`).join("/")
    const mix = Object.keys(variantCounts).length ? ` (${Object.entries(variantCounts).sort().map(([k, v]) => `${k}:${v}`).join(" ")})` : ""
    const today = ptToday()
    await telegram(
      `📝 <b>${needReview}</b> ${touchList} emails drafted for the next weekday${mix}, from ${SEND_AS}.${lintFailed ? ` ${lintFailed} rejected by lint (not queued).` : ""}\n\nTap ✅ to approve all of them — they go out at random minutes 7am-5pm PT. Untapped = nothing sends; this batch expires at the next evening mint.`,
      [
        { text: `✅ Send all ${needReview}`, callback_data: `bapprove:${today}` },
        { text: "👀 Review first", url: REVIEW_URL },
      ]
    )
  }
}

// ---------- SEND pass ----------
// One-click unsubscribe (RFC 8058, 2026-08-06 deliverability work): Gmail
// strongly favors bulk mail with these headers; the POST target writes
// straight to the master DNC.
// Auth + MIME live in scripts/campaign-gmail.mjs (shared with the test-batch
// sender): DWD for lrghomes.com mailboxes, OAuth for the consumer Gmail.
// T1 sends carry NO List-Unsubscribe headers (2026-08-21 finding: headers
// alone flipped Primary → Promotions; the body's "reply remove" line covers
// opt-out). T2+ keep the one-click headers.
const gmailClient = () => gmailClientFor(SEND_AS)

async function loadRamp() {
  const { data } = await sb.from("campaign_settings").select("value").eq("key", "ramp").maybeSingle()
  RAMP = { step: 0, ...(data?.value ?? {}) }
  const cap = RAMP_SCHEDULE[Math.min(RAMP.step, RAMP_SCHEDULE.length - 1)]
  SEND_DAILY_CAP = Math.min(SEND_DAILY_CAP, cap)
  DRAFT_DAILY_CAP = Math.min(DRAFT_DAILY_CAP, cap)
  log(`ramp step ${RAMP.step}: cap ${cap}/day${RAMP.held_reason ? ` (last: ${RAMP.held_reason})` : ""}`)
}
async function saveRamp(patch) {
  RAMP = { ...RAMP, ...patch, updated_at: new Date().toISOString() }
  await sb.from("campaign_settings").upsert({ key: "ramp", value: RAMP, updated_at: RAMP.updated_at })
}

// ---- Phase B guardrails: pause flag (shared with Telegram "pause campaign") ----
async function getPause() {
  const { data } = await sb.from("campaign_settings").select("value").eq("key", "pause").maybeSingle()
  const v = data?.value ?? {}
  if (v.paused && v.until && new Date(v.until).getTime() < Date.now()) return { paused: false }
  return v
}
async function setPause(reason, hours) {
  const value = { paused: true, reason, by: "engine", at: new Date().toISOString(), until: hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null }
  await sb.from("campaign_settings").upsert({ key: "pause", value, updated_at: new Date().toISOString() })
}
async function bouncesToday() {
  const p = ptDateParts(new Date())
  const start = new Date(`${p.year}-${p.month}-${p.day}T00:00:00-07:00`).toISOString()
  const { count } = await sb.from("campaign_events").select("id", { count: "exact", head: true }).eq("kind", "bounce").gte("occurred_at", start)
  return count ?? 0
}
const THROTTLE_RE = /\b429\b|rate ?limit|quota|too many|user-rate|backend error|temporarily/i

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

  // Phase B guardrails (2026-08-21)
  const pause = await getPause()
  if (pause.paused) {
    log(`PAUSED (${pause.reason ?? "manual"}${pause.until ? ` until ${pause.until}` : ""}) — no sends`)
    return
  }
  if (/@lrghomes\.com$/i.test(SEND_AS) && !process.env.CAMPAIGN_ALLOW_DOMAIN_COLD) {
    log(`REFUSING: cold sends from ${SEND_AS} are disabled (lrghomes.com is spam-flagged at Gmail; set CAMPAIGN_ALLOW_DOMAIN_COLD=1 to override)`)
    await telegram(`⛔ Campaign send pass refused: sender is ${SEND_AS} (lrghomes.com cold sends are disabled). Fix CAMPAIGN_SEND_AS.`)
    return
  }
  const sentToday = await countToday("campaign_sends", "sent_at", { status: ["sent"] })
  const bounced = await bouncesToday()
  if (sentToday >= 10 && bounced / sentToday >= BOUNCE_PAUSE_RATE) {
    await setPause(`bounce rate ${bounced}/${sentToday} today (≥${BOUNCE_PAUSE_RATE * 100}%)`, 48)
    await telegram(`⏸ Campaign AUTO-PAUSED 48h: ${bounced} bounces on ${sentToday} sends today (≥2%). Reply "resume campaign" to override after checking the list.`)
    return
  }
  // Warm-up ramp for the ryansvr@ migration (2026-08-06): 75/day week one,
  // 150 week two, full cap after. Clear CAMPAIGN_RAMP_START to disable.
  let rampCap = SEND_DAILY_CAP
  if (process.env.CAMPAIGN_RAMP_START) {
    const days = Math.floor((Date.now() - new Date(`${process.env.CAMPAIGN_RAMP_START}T00:00:00-07:00`).getTime()) / 86400_000)
    rampCap = days < 7 ? 75 : days < 14 ? 150 : SEND_DAILY_CAP
  }
  const effectiveCap = Math.min(SEND_DAILY_CAP, rampCap)
  let budget = Math.max(0, effectiveCap - sentToday)
  if (limit !== null) budget = Math.min(budget, limit)
  log(`send pass: ${sentToday} sent today, cap ${effectiveCap}${effectiveCap !== SEND_DAILY_CAP ? " (warm-up ramp)" : ""}, budget ${budget}, ${inWindow ? "in-window" : "OUT of window"}`)
  if (budget === 0) return

  const nowIso = new Date().toISOString()
  // Eligible = approved AND (no schedule OR its scheduled time has arrived).
  const { data: eligible, error } = await sb
    .from("campaign_sends")
    .select("id, contact_id, touch_number, subject, body, status, scheduled_for, variant, body_hash")
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
    // Never send a body that already went out (unique index backs this up).
    if (row.body_hash) {
      const { data: dupe } = await sb.from("campaign_sends").select("id").eq("body_hash", row.body_hash).eq("status", "sent").neq("id", row.id).limit(1)
      if (dupe?.length) {
        await markFailed(row, `duplicate body (hash matches sent ${dupe[0].id})`)
        failed++
        continue
      }
    }
    try {
      const msg = await sendCampaignMessage(gmail, {
        from: SEND_AS,
        to,
        subject: row.subject,
        body: row.body,
        contactId: row.contact_id,
        unsubHeaders: row.touch_number !== 1,
      })
      const nowIso = new Date().toISOString()
      await sb.from("campaign_sends").update({
        status: "sent",
        sent_at: nowIso,
        gmail_message_id: msg.id ?? null,
        gmail_thread_id: msg.threadId ?? null,
        sender: SEND_AS,
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
        body: `T${row.touch_number}${row.variant ? ` [${row.variant}]` : ""}: ${row.subject}`,
        occurred_at: nowIso,
        raw: { mailbox: SEND_AS, variant: row.variant ?? null, send_id: row.id },
      })
      sent++
      log(`sent T${row.touch_number} → ${to}`)
    } catch (e) {
      const m = e?.message ?? String(e)
      await markFailed(row, m)
      failed++
      if (THROTTLE_RE.test(m)) {
        await setPause(`Gmail throttle: ${m.slice(0, 120)}`, 48)
        await telegram(`⏸ Campaign AUTO-PAUSED 48h on a Gmail throttle/quota response: <code>${m.slice(0, 200)}</code>. Remaining approved emails stay queued.`)
        break
      }
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

// ---------- Health monitoring (Phase B, 2026-08-21: "monitor and learn as we go") ----------
// No Postmaster Tools exist for a gmail.com sender, so we watch every signal
// we CAN see and keep a daily snapshot for trends: sent, bounces, genuine
// replies, removes/unsubs, auto-replies, send failures, lint rejections,
// pauses, and a daily CANARY (one freshly composed email to a never-opened
// inbox Ryan reads once a week for placement). Snapshots live in
// campaign_settings under health:<date> so the Friday scorecard and later
// analysis can read them back.
const HEALTH_STATE = path.join(__dirname, ".campaign-health-state.json")
function readHealthState() {
  try { return JSON.parse(fs.readFileSync(HEALTH_STATE, "utf-8")) } catch { return {} }
}
function bumpHealthCounter(key, n = 1) {
  const st = readHealthState()
  const day = ptToday()
  st[day] = st[day] || {}
  st[day][key] = (st[day][key] || 0) + n
  fs.writeFileSync(HEALTH_STATE, JSON.stringify(st))
}

async function dayMetrics(dayStr) {
  const start = new Date(`${dayStr}T00:00:00-07:00`).toISOString()
  const end = new Date(`${dayStr}T23:59:59-07:00`).toISOString()
  const cnt = async (table, col, mods) => {
    let q = sb.from(table).select("id", { count: "exact", head: true }).gte(col, start).lte(col, end)
    for (const [k, v] of Object.entries(mods)) q = Array.isArray(v) ? q.in(k, v) : v === null ? q.is(k, null) : q.eq(k, v)
    const { count } = await q
    return count ?? 0
  }
  const sent = await cnt("campaign_sends", "sent_at", { status: "sent" })
  const failed = await cnt("campaign_sends", "created_at", { status: "failed" })
  const bounces = await cnt("campaign_events", "occurred_at", { kind: "bounce" })
  const replies = await cnt("campaign_events", "occurred_at", { kind: "email_reply", triage: null })
  const unsubs = await cnt("campaign_events", "occurred_at", { kind: "email_reply", triage: "unsubscribe" })
  const autoReplies = await cnt("campaign_events", "occurred_at", { kind: "email_reply", triage: ["auto_reply", "dead_mailbox"] })
  const local = readHealthState()[dayStr] || {}
  return { day: dayStr, sent, failed, bounces, replies, unsubs, autoReplies, lint_rejected: local.lint_rejected || 0, canary: local.canary || null }
}

async function canaryPass() {
  const to = process.env.CAMPAIGN_CANARY_TO
  if (!to || dryRun) return
  const st = readHealthState()
  const day = ptToday()
  if (st[day]?.canary) return
  const sentToday = await countToday("campaign_sends", "sent_at", { status: ["sent"] })
  if (sentToday === 0) return // canary only rides along with a real send day
  const { data: vt } = await sb.from("campaign_variants").select("*").eq("variant", "B").single()
  if (!vt) return
  const n = Object.values(st).filter((d) => d?.canary).length + 1
  const composed = await composeVariantBody({ variant: vt, contact: { id: `canary-${day}`, name: "Ryan", first_name: "Ryan", email: to }, seed: `canary-${day}` })
  const gmail = await gmailClient()
  await sendCampaignMessage(gmail, { from: SEND_AS, to, subject: `[C${n}] ${composed.subject}`, body: composed.body, contactId: null, unsubHeaders: false })
  bumpHealthCounter("canary_sent", 1)
  st[day] = { ...(readHealthState()[day] || {}), canary: `C${n}` }
  fs.writeFileSync(HEALTH_STATE, JSON.stringify(st))
  log(`canary C${n} sent → ${to}`)
}

async function healthPass() {
  // Once per weekday after 5:15pm PT (the window closed at 5:00).
  if (dryRun) return
  const wd = laWeekdayNow()
  const forced = args.includes("--health-now") // rehearsal flag
  if (!forced && (wd === "Sat" || wd === "Sun")) return
  const now = new Date()
  const minutes = laHourNow() * 60 + Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", minute: "numeric" }).format(now))
  if (!forced && minutes < 17 * 60 + 15) return
  const day = ptToday()
  const { data: existing } = await sb.from("campaign_settings").select("key").eq("key", `health:${day}`).maybeSingle()
  if (existing) return
  const m = await dayMetrics(day)
  // 7-day trailing window for context
  const days = []
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getTime() - i * 86_400_000)
    const p = ptDateParts(d)
    days.push(`${p.year}-${p.month}-${p.day}`)
  }
  const { data: hist } = await sb.from("campaign_settings").select("value").in("key", days.map((d) => `health:${d}`))
  const agg = (hist ?? []).map((r) => r.value).reduce((a, v) => ({ sent: a.sent + (v.sent || 0), bounces: a.bounces + (v.bounces || 0), replies: a.replies + (v.replies || 0), unsubs: a.unsubs + (v.unsubs || 0) }), { sent: 0, bounces: 0, replies: 0, unsubs: 0 })
  const pause = await getPause()
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—")
  const warnings = []
  if (m.sent && m.bounces / m.sent >= 0.01) warnings.push(`bounce rate ${pct(m.bounces, m.sent)} (watch line 1%, auto-pause 2%)`)
  if (m.unsubs >= 2) warnings.push(`${m.unsubs} removes in one day`)
  if (m.failed) warnings.push(`${m.failed} send failures`)
  if (m.lint_rejected >= 3) warnings.push(`${m.lint_rejected} drafts rejected by lint`)
  if (agg.sent >= 40 && agg.replies / agg.sent < 0.01) warnings.push(`7-day reply rate ${pct(agg.replies, agg.sent)} — below 1%`)
  if (pause.paused) warnings.push(`PAUSED: ${pause.reason}`)
  const status = warnings.length ? (warnings.some((w) => /PAUSED|2%/.test(w)) ? "🔴" : "🟡") : "🟢"
  const snapshot = { ...m, warnings, sender: SEND_AS, cap: SEND_DAILY_CAP, ramp_step: RAMP.step, recorded_at: now.toISOString() }
  await sb.from("campaign_settings").upsert({ key: `health:${day}`, value: snapshot, updated_at: now.toISOString() })
  // Ramp decision for the next send day
  let rampNote = ""
  const maxStep = RAMP_SCHEDULE.length - 1
  if (m.sent > 0) {
    if (status === "🟢" && m.sent >= SEND_DAILY_CAP && RAMP.step < maxStep) {
      await saveRamp({ step: RAMP.step + 1, held_reason: null, last_change: day })
      rampNote = `\n\n⬆️ Ramp: green day at ${m.sent}/day → next batch ${RAMP_SCHEDULE[RAMP.step]}/day.`
    } else if (status === "🔴" && RAMP.step > 0) {
      await saveRamp({ step: RAMP.step - 1, held_reason: warnings[0], last_change: day })
      rampNote = `\n\n⬇️ Ramp: dropped back to ${RAMP_SCHEDULE[RAMP.step]}/day.`
    } else if (status === "🟡") {
      await saveRamp({ held_reason: warnings[0] })
      rampNote = `\n\n⏸ Ramp held at ${RAMP_SCHEDULE[RAMP.step]}/day until a green day.`
    } else if (m.sent < SEND_DAILY_CAP) {
      rampNote = `\n\nRamp holds at ${RAMP_SCHEDULE[RAMP.step]}/day (only ${m.sent} of ${SEND_DAILY_CAP} went out).`
    }
  }
  if (m.sent === 0 && !warnings.length) { log("health: no sends today, snapshot stored, no card"); return }
  await telegram(
    `🩺 <b>Campaign health ${status} — ${wd} ${day.slice(5)}</b>\n` +
      `📤 ${m.sent} sent from ${SEND_AS} (cap ${SEND_DAILY_CAP}) · ↩️ ${m.bounces} bounced (${pct(m.bounces, m.sent)}) · 💬 ${m.replies} replies · 🚫 ${m.unsubs} removes · 🤖 ${m.autoReplies} auto-replies · ⚠️ ${m.failed} failed · 🧹 ${m.lint_rejected} lint-rejected` +
      (m.canary ? ` · 🐤 canary ${m.canary} sent` : "") +
      `\n📈 7-day: ${agg.sent} sent, bounces ${pct(agg.bounces, agg.sent)}, replies ${pct(agg.replies, agg.sent)}, ${agg.unsubs} removes` +
      (warnings.length ? `\n\n${warnings.map((w) => `• ${escHtml(w)}`).join("\n")}` : "\n\nAll clear.") + rampNote
  )
  log(`health card sent: ${status} ${warnings.join("; ")}`)
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
      .is("triage", null) // genuine replies only — not OOO/dead-mailbox/unsub rows
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
// Each pass runs isolated (2026-09-01): a single try/catch used to abort the
// whole run — the Aug-31 invalid_grant crash in sendPass took digest, canary,
// health and the ramp bookkeeping down with it, so 4 dead days produced no
// health card at all. One Telegram at the end names every failed pass.
const passFailures = []
async function runPass(name, fn) {
  try { await fn(); return true } catch (e) {
    const msg = e?.message ?? String(e)
    console.error(`[campaign] ${name} pass error:`, msg)
    passFailures.push(`${name}: ${String(msg).slice(0, 120)}`)
    return false
  }
}
const rampOk = await runPass("ramp", loadRamp)
// Without ramp state the caps fall back to env defaults — skip the passes
// that would send/draft at the wrong volume; observation passes still run.
if (rampOk && !digestOnly && doDraft) await runPass("draft", draftPass)
if (rampOk && !digestOnly && doSend) await runPass("send", sendPass)
await runPass("digest", digestPass)
if (rampOk && !digestOnly && doSend) await runPass("canary", canaryPass)
await runPass("health", healthPass)
await runPass("scorecard", scorecardPass)
if (passFailures.length) {
  await telegram(`🔥 Campaign engine: ${passFailures.length} pass(es) failed — ${passFailures.join(" · ")}`)
  process.exit(1)
}
