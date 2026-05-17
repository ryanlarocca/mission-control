#!/usr/bin/env node
/* eslint-disable */
/**
 * Phase 7B Lead Drip Engine.
 *
 * Run hourly via launchd (infrastructure/launchd/com.lrghomes.drip-engine.plist).
 * One pass = (1) drain any approved drip_queue rows from previous runs,
 * (2) scan eligible leads, (3) for each lead due a touch, check for active
 * conversation, generate content via Haiku, and either auto-send (if
 * DRIP_AUTO_SEND=true) or queue + Telegram approval gate.
 *
 * The campaign cadence definitions are duplicated from lib/drip-campaigns.ts —
 * keep both files in sync. The engine has to live in plain CJS because the
 * launchd job runs `node scripts/drip-engine.js` with no TS toolchain.
 *
 * Usage:
 *   node scripts/drip-engine.js                # full pass
 *   node scripts/drip-engine.js --dry-run      # generate but don't queue/send
 *   node scripts/drip-engine.js --lead <uuid>  # process a single lead by id
 */

"use strict"

const fs = require("node:fs")
const path = require("node:path")
const { google } = require("googleapis")
const { createClient } = require("@supabase/supabase-js")

// ─── env loader (matches scripts/run-migration.mjs) ─────────────────────────

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

const args = process.argv.slice(2)
const DRY_RUN = args.includes("--dry-run")
const LEAD_FILTER_ID = (() => {
  const i = args.indexOf("--lead")
  return i >= 0 ? args[i + 1] : null
})()
const AUTO_SEND = (process.env.DRIP_AUTO_SEND || "false").toLowerCase() === "true"
const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"
const APPLE_EPOCH_OFFSET_MS = 978307200000

// ─── campaign cadence (mirrors lib/drip-campaigns.ts) ───────────────────────

const GOOGLE_ADS_FORM_TOUCHES = [
  { touchNumber: 1,  delayHours: 30,   channel: "imessage" },
  { touchNumber: 2,  delayHours: 48,   channel: "email" },
  { touchNumber: 3,  delayHours: 72,   channel: "imessage" },
  { touchNumber: 4,  delayHours: 168,  channel: "email" },
  { touchNumber: 5,  delayHours: 336,  channel: "imessage" },
  { touchNumber: 6,  delayHours: 720,  channel: "email" },
  { touchNumber: 7,  delayHours: 1440, channel: "imessage" },
  { touchNumber: 8,  delayHours: 2160, channel: "email" },
  { touchNumber: 9,  delayHours: 2160, channel: "imessage" },
  { touchNumber: 10, delayHours: 2160, channel: "email" },
  { touchNumber: 11, delayHours: 2160, channel: "imessage" },
  { touchNumber: 12, delayHours: 2160, channel: "email" },
  { touchNumber: 13, delayHours: 2160, channel: "imessage" },
]
const ALL_EMAIL = (touches) => touches.map((t) => ({ ...t, channel: "email" }))
const ALL_IMESSAGE = (touches) => touches.map((t) => ({ ...t, channel: "imessage" }))

// Mirror lib/drip-campaigns.ts exactly — these were diverging (engine used
// the GOOGLE_ADS_FORM_TOUCHES cadence, lib used a slower one). The UI
// forecasts off lib, so the engine has to use the same numbers or the
// forecast lies. Schedule is 48h → 72h → 168h → 336h → 720h → 1440h →
// 2160h (every 90d after touch #7).
const DIRECT_MAIL_CALL_TOUCHES = [
  { touchNumber: 0,  delayHours: 0.25, channel: "imessage" }, // missed-call only
  { touchNumber: 1,  delayHours: 48,   channel: "imessage" },
  { touchNumber: 2,  delayHours: 72,   channel: "imessage" },
  { touchNumber: 3,  delayHours: 168,  channel: "imessage" },
  { touchNumber: 4,  delayHours: 336,  channel: "imessage" },
  { touchNumber: 5,  delayHours: 720,  channel: "imessage" },
  { touchNumber: 6,  delayHours: 1440, channel: "imessage" },
  { touchNumber: 7,  delayHours: 2160, channel: "imessage" },
  { touchNumber: 8,  delayHours: 2160, channel: "imessage" },
  { touchNumber: 9,  delayHours: 2160, channel: "imessage" },
  { touchNumber: 10, delayHours: 2160, channel: "imessage" },
  { touchNumber: 11, delayHours: 2160, channel: "imessage" },
  { touchNumber: 12, delayHours: 2160, channel: "imessage" },
  { touchNumber: 13, delayHours: 2160, channel: "imessage" },
]

// Long-term nurture — must match lib/drip-campaigns.ts exactly. Soft
// cadence for "not now, maybe in 1-2 years" leads. Cumulative timing:
// 60 / 120 / 180 / 240 / 365 / 540 days from apply time.
const LONG_TERM_NURTURE_TOUCHES = [
  { touchNumber: 1, delayHours: 1440, channel: "email" },     // 60d
  { touchNumber: 2, delayHours: 1440, channel: "imessage" },  // +60d → 120d
  { touchNumber: 3, delayHours: 1440, channel: "email" },     // +60d → 180d
  { touchNumber: 4, delayHours: 1440, channel: "imessage" },  // +60d → 240d
  { touchNumber: 5, delayHours: 3000, channel: "email" },     // +125d → 365d
  { touchNumber: 6, delayHours: 4200, channel: "imessage" },  // +175d → 540d
]

const DRIP_CAMPAIGNS = {
  google_ads_form: {
    type: "google_ads_form",
    entryDelayHours: 0,
    touches: GOOGLE_ADS_FORM_TOUCHES,
  },
  google_ads_email_only: {
    type: "google_ads_email_only",
    entryDelayHours: 0,
    touches: ALL_EMAIL(GOOGLE_ADS_FORM_TOUCHES),
  },
  direct_mail_call: {
    type: "direct_mail_call",
    entryDelayHours: 0,
    touches: DIRECT_MAIL_CALL_TOUCHES,
  },
  direct_mail_sms: {
    type: "direct_mail_sms",
    entryDelayHours: 48,
    touches: ALL_IMESSAGE(GOOGLE_ADS_FORM_TOUCHES),
  },
  direct_mail_email: {
    type: "direct_mail_email",
    entryDelayHours: 48,
    touches: ALL_EMAIL(GOOGLE_ADS_FORM_TOUCHES),
  },
  long_term_nurture: {
    type: "long_term_nurture",
    entryDelayHours: 0,
    touches: LONG_TERM_NURTURE_TOUCHES,
  },
}

// Phase 7C: lifecycle-only stop list. Active = Ryan's working it; dead =
// terminal. The DNC and Junk *flags* (is_dnc / is_junk) are checked
// separately in fetchEligibleLeads so a lead can be `dead` without being
// DNC, and `is_dnc` halts everything regardless of status.
const DRIP_STOP_STATUSES = new Set(["active", "dead"])

// When an email-only campaign acquires a phone, alternate channels by
// touch parity (odd → iMessage, even → email). Mirrors google_ads_form's
// pattern. Returns the original channel when phone is absent / N/A.
function effectiveChannel(campaign, touchNumber, hasPhone) {
  const defined = campaign.touches.find((t) => t.touchNumber === touchNumber)
  if ((campaign.type === "direct_mail_email" || campaign.type === "google_ads_email_only") && hasPhone) {
    return touchNumber % 2 === 1 ? "imessage" : "email"
  }
  // Long-term nurture downgrades its iMessage touches to email when the
  // lead has no phone — otherwise they silently no-op.
  if (campaign.type === "long_term_nurture" && !hasPhone) {
    return "email"
  }
  return defined ? defined.channel : "imessage"
}

function getNextTouch(campaign, currentTouchNumber) {
  const cur = currentTouchNumber == null ? -1 : currentTouchNumber
  return campaign.touches.find((t) => t.touchNumber > cur) || null
}

// ─── supabase ───────────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.LRG_SUPABASE_URL
  const key = process.env.LRG_SUPABASE_SERVICE_KEY
  if (!url || !key) {
    throw new Error("LRG_SUPABASE_URL and LRG_SUPABASE_SERVICE_KEY must be set")
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

// ─── activity check via sidecar ─────────────────────────────────────────────

async function fetchIMessageHistory(phone) {
  if (!phone) return []
  try {
    const res = await fetch(`${SIDECAR_URL}/sync-imessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    })
    if (!res.ok) {
      console.warn(`[drip] sync-imessage HTTP ${res.status} for ${phone}`)
      return []
    }
    const data = await res.json()
    return Array.isArray(data.messages) ? data.messages : []
  } catch (e) {
    console.warn(`[drip] sync-imessage error for ${phone}:`, e.message)
    return []
  }
}

// "Active conversation" means any message (inbound from lead OR outbound from
// Ryan that wasn't a drip) since last_drip_sent_at. The brief calls this the
// HOLD condition: drip pauses, clock resets to give the human conversation
// space. last_drip_sent_at is ISO; sidecar timestamps are Apple-epoch ms.
async function hasActiveConversation(lead, sb) {
  const sinceUnixMs = lead.last_drip_sent_at
    ? new Date(lead.last_drip_sent_at).getTime()
    : new Date(lead.created_at).getTime()
  const sinceAppleMs = sinceUnixMs - APPLE_EPOCH_OFFSET_MS

  // chat.db check (only meaningful when we have a phone)
  if (lead.caller_phone) {
    const messages = await fetchIMessageHistory(lead.caller_phone)
    const recent = messages.filter((m) => Number(m.timestamp) > sinceAppleMs)
    if (recent.length > 0) {
      console.log(`[drip] HOLD lead ${lead.id}: ${recent.length} chat.db msg(s) since last touch`)
      return { hold: true, reason: "chatdb_recent" }
    }
  }

  // Supabase rows: any non-drip activity since last_drip_sent_at means the
  // human is engaged. Drip-sent rows have lead_type prefixed with "drip_".
  // Match by phone if we have one, else by email. PostgREST `.or()` would
  // mishandle the "+" in E.164 phones; an .eq() chain is safer.
  const sinceIso = new Date(sinceUnixMs).toISOString()
  const baseQuery = sb
    .from("leads")
    .select("id, lead_type, twilio_number, message, created_at")
    .gt("created_at", sinceIso)
  const { data: events, error } = lead.caller_phone
    ? await baseQuery.eq("caller_phone", lead.caller_phone)
    : lead.email
    ? await baseQuery.eq("email", lead.email)
    : { data: [], error: null }
  if (error) {
    console.warn(`[drip] activity query failed for ${lead.id}:`, error.message)
    return { hold: false, reason: "query_error" }
  }
  for (const ev of events || []) {
    if (!ev.lead_type) continue
    if (ev.lead_type.startsWith("drip_")) continue
    // Any non-drip event (inbound or Ryan's manual outbound) is a HOLD.
    return { hold: true, reason: `db_${ev.lead_type}` }
  }
  return { hold: false }
}

// ─── conversation history (for prompt context) ─────────────────────────────

async function buildConversationHistory(lead, sb) {
  const lines = []
  // Pull all leads-table rows that share a contact key, oldest → newest.
  let q = sb
    .from("leads")
    .select("created_at, lead_type, twilio_number, message")
    .order("created_at", { ascending: true })
    .limit(50)
  if (lead.caller_phone) {
    q = q.eq("caller_phone", lead.caller_phone)
  } else if (lead.email) {
    q = q.eq("email", lead.email)
  } else {
    q = q.eq("id", lead.id)
  }
  const { data, error } = await q
  if (error) {
    console.warn(`[drip] history query failed for ${lead.id}:`, error.message)
    return ""
  }
  for (const row of data || []) {
    const isOut = !row.twilio_number
    const dir = isOut
      ? (row.lead_type && row.lead_type.startsWith("drip_") ? "ryan(drip)" : "ryan")
      : "lead"
    const txt = (row.message || "").trim().slice(0, 600)
    if (!txt) continue
    lines.push(`[${row.created_at}] ${dir}: ${txt}`)
  }

  // chat.db tail — adds messages we haven't logged into Supabase yet.
  if (lead.caller_phone) {
    const msgs = await fetchIMessageHistory(lead.caller_phone)
    for (const m of msgs.slice(-20)) {
      const dir = m.is_from_me ? "ryan" : "lead"
      const ts = new Date(Number(m.timestamp) + APPLE_EPOCH_OFFSET_MS).toISOString()
      const txt = (m.text || "").trim().slice(0, 600)
      if (!txt) continue
      lines.push(`[${ts}] ${dir}(imsg): ${txt}`)
    }
  }
  return lines.join("\n")
}

// ─── responsiveness signal extraction ───────────────────────────────────────
//
// Look at the cluster's recent activity and answer one question: has the lead
// actually responded to anything Ryan has sent? The raw transcript blob in
// `history` *contains* the answer but Haiku has to infer it, which goes
// wrong (e.g. drafting "Got your missed call yesterday" to a lead Ryan has
// been chasing). This extractor surfaces the pattern as structured signal
// so the prompt can pick a different phase guidance variant deterministically.
//
// State definitions:
//   engaged      — lead has replied since Ryan's most recent outbound, within 7d
//   gone_quiet   — lead responded earlier but has stopped (no inbound in 7d+
//                  AND Ryan has reached out since their last inbound)
//   never_responded — Ryan has made >=1 outbound; the lead has never replied
//                  to outreach (inbounds BEFORE Ryan's first outbound — like a
//                  Google-Ads form submission — don't count as a "response")
//   first_contact — no outbound has gone out yet; treat as standard phase
//
// Counts cover the last 30d so the prompt can quote real numbers.

const RESPONSIVENESS_WINDOW_DAYS = 30
const GONE_QUIET_DAYS = 7

function isOutboundRow(row) {
  // leads-table heuristic: rows that came through Twilio have a non-null
  // twilio_number (inbound from the lead's perspective — they dialed in or
  // texted Ryan's Twilio line). Outbound rows from Ryan have a null
  // twilio_number. Drip-sent rows are also outbound and start with "drip_".
  if (row.lead_type && String(row.lead_type).startsWith("drip_")) return true
  return !row.twilio_number
}

function classifyOutbound(leadType) {
  const t = String(leadType || "")
  if (t === "call" || t === "voicemail" || t === "outbound_call") return "call"
  if (t.startsWith("drip_imessage") || t === "imessage_outbound" || t === "sms_outbound") return "imessage"
  if (t.startsWith("drip_email") || t === "email_outbound") return "email"
  return "other"
}

function classifyInbound(leadType) {
  const t = String(leadType || "")
  if (t === "call" || t === "voicemail") return "call"
  if (t === "sms" || t === "imessage" || t === "imessage_inbound") return "sms"
  if (t === "email" || t === "email_inbound") return "email"
  // form_submission / google_ads_form etc. are inbound but not a "reply".
  if (t.includes("form")) return "form"
  return "other"
}

// "Brief inbound" patterns. Strip punctuation/whitespace, lowercase, then
// match. If the lead's most-recent inbound matches one of these AND is
// short, we treat it as substance-free — useful for direct_mail_call leads
// where someone called back, left a "thank you" voicemail, and never said
// what they wanted. The drip then needs to ASK what they were reaching out
// about, not pretend it knows.
const BRIEF_INBOUND_PATTERNS = [
  /^$/,                                          // empty (failed transcription)
  /^(thanks?|thank you|ty|appreciate it|cool|ok+|okay|sure|yes|yep|no|nope|hi|hello|hey)\.?$/,
  /^(got it|sounds good|will do|talk soon|bye|goodbye)\.?$/,
]
const BRIEF_INBOUND_MAX_CHARS = 60

function isBriefInbound(messageText) {
  const txt = (messageText || "").trim().toLowerCase().replace(/[.,!?]+$/, "")
  if (txt.length === 0) return true
  if (txt.length > BRIEF_INBOUND_MAX_CHARS) return false
  return BRIEF_INBOUND_PATTERNS.some((re) => re.test(txt))
}

async function extractResponsivenessSignals(lead, sb) {
  const since = new Date(Date.now() - RESPONSIVENESS_WINDOW_DAYS * 86400000).toISOString()
  let q = sb
    .from("leads")
    .select("created_at, lead_type, twilio_number, message")
    .order("created_at", { ascending: true })
    .gte("created_at", since)
    .limit(200)
  if (lead.caller_phone) q = q.eq("caller_phone", lead.caller_phone)
  else if (lead.email) q = q.eq("email", lead.email)
  else q = q.eq("id", lead.id)
  const { data, error } = await q
  if (error) {
    console.warn(`[drip] responsiveness query failed for ${lead.id}:`, error.message)
    return null
  }

  const events = []
  for (const row of data || []) {
    const isOut = isOutboundRow(row)
    events.push({ ts: row.created_at, isOut, kind: isOut ? classifyOutbound(row.lead_type) : classifyInbound(row.lead_type), text: row.message || "" })
  }

  // Add chat.db tail (best-effort — sidecar may be down). Only counts the
  // most recent 50 messages within our window.
  if (lead.caller_phone) {
    try {
      const msgs = await fetchIMessageHistory(lead.caller_phone)
      for (const m of msgs.slice(-50)) {
        const ts = new Date(Number(m.timestamp) + APPLE_EPOCH_OFFSET_MS).toISOString()
        if (ts < since) continue
        events.push({ ts, isOut: !!m.is_from_me, kind: m.is_from_me ? "imessage" : "sms" })
      }
    } catch (_) { /* ignore */ }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts))

  const outbound = { call: 0, imessage: 0, email: 0 }
  const inbound = { call: 0, sms: 0, email: 0 }
  let firstOutboundTs = null
  let lastOutboundTs = null
  let lastInboundTs = null
  let lastInboundKind = null    // 'call' | 'voicemail-like' | 'sms' | 'email'
  let lastInboundText = ""      // raw transcript / message body for the most recent inbound
  let responsesSinceFirstOutbound = 0
  let lastResponseTs = null

  for (const e of events) {
    if (e.isOut) {
      if (e.kind === "call") outbound.call += 1
      else if (e.kind === "imessage") outbound.imessage += 1
      else if (e.kind === "email") outbound.email += 1
      if (!firstOutboundTs) firstOutboundTs = e.ts
      lastOutboundTs = e.ts
    } else {
      // Form submissions don't count as a "response" to outreach — they're
      // the original lead source.
      if (e.kind === "form") continue
      if (e.kind === "call") inbound.call += 1
      else if (e.kind === "sms") inbound.sms += 1
      else if (e.kind === "email") inbound.email += 1
      lastInboundTs = e.ts
      lastInboundKind = e.kind
      lastInboundText = e.text || ""
      if (firstOutboundTs && e.ts > firstOutboundTs) {
        responsesSinceFirstOutbound += 1
        lastResponseTs = e.ts
      }
    }
  }

  // "Brief inbound" classification — only relevant when there IS a recent
  // inbound to characterize. Used by the prompt to switch touch #1 from
  // "follow up on the letter" → "I see you called/voicemailed me, were
  // you reaching out about a letter I sent?".
  const briefInbound = lastInboundTs != null && isBriefInbound(lastInboundText)

  const outboundTotal = outbound.call + outbound.imessage + outbound.email
  const inboundTotal = inbound.call + inbound.sms + inbound.email
  const daysSinceLastInbound = lastInboundTs
    ? Math.floor((Date.now() - new Date(lastInboundTs).getTime()) / 86400000)
    : null
  const daysSinceLastResponse = lastResponseTs
    ? Math.floor((Date.now() - new Date(lastResponseTs).getTime()) / 86400000)
    : null

  let state
  if (outboundTotal === 0) {
    state = "first_contact"
  } else if (responsesSinceFirstOutbound === 0) {
    state = "never_responded"
  } else if (daysSinceLastResponse !== null && daysSinceLastResponse >= GONE_QUIET_DAYS) {
    state = "gone_quiet"
  } else {
    state = "engaged"
  }

  return {
    state,
    outbound,
    inbound,
    outboundTotal,
    inboundTotal,
    daysSinceLastInbound,
    daysSinceLastResponse,
    responsesSinceFirstOutbound,
    briefInbound,
    lastInboundKind,
  }
}

// ─── junk filter (Part 8) ───────────────────────────────────────────────────

const HARD_STOP_PATTERNS = [
  /\btake me off\b/i,
  /\btake (?:my (?:name|number) )?off (?:your|the) list\b/i,
  /\bstop texting\b/i,
  /\bstop messaging\b/i,
  /\bstop emailing\b/i,
  /\bstop calling\b/i,
  /\bstop calling me\b/i,
  /\bdo not call\b/i,
  /\bdon'?t call\b/i,
  /\bdon'?t contact\b/i,
  /\bquit calling\b/i,
  /\bremove me\b/i,
  /\bnot interested\b/i,
  /\bwrong number\b/i,
  /\bfuck off\b/i,
  /\bleave me alone\b/i,
  /\bunsubscribe\b/i,
  /\bcease (?:and desist|contact)\b/i,
]

function detectHardStop(history) {
  for (const re of HARD_STOP_PATTERNS) {
    const m = re.exec(history)
    if (m) return m[0]
  }
  return null
}

// Soft signals — flag for clarifying-question tone but don't stop.
const BAY_AREA_HINT = /\b(bay area|san jose|oakland|fremont|santa clara|sunnyvale|cupertino|palo alto|mountain view|hayward|san mateo|redwood city|san francisco|sf|peninsula|silicon valley)\b/i
const SOFT_MISMATCH_PATTERNS = [
  /\bmobile home\b/i,
  /\btrailer\b/i,
  /\bmanufactured home\b/i,
  /\brenting\b/i,
  /\bmy landlord\b/i,
  /\bi\s+rent\b/i,
]

function detectSoftSignals(lead, history) {
  const reasons = []
  for (const re of SOFT_MISMATCH_PATTERNS) {
    if (re.test(history)) {
      reasons.push(`pattern:${re.source}`)
      break
    }
  }
  // Property mismatch — only when we actually have an address that names a
  // city/state outside the Bay Area. We avoid false positives by checking if
  // the address mentions a clearly non-CA state abbreviation.
  if (lead.property_address) {
    const addr = lead.property_address
    const looksOutOfArea = /\b(NY|TX|FL|WA|OR|AZ|NV|IL|MA|CO|GA|NC|VA|OH|MI|PA)\b/.test(addr)
    if (looksOutOfArea && !BAY_AREA_HINT.test(addr)) {
      reasons.push("address:out_of_area")
    }
  }
  return reasons
}

// ─── content generation (Haiku via OpenRouter) ──────────────────────────────

const HAIKU_MODEL = "anthropic/claude-haiku-4-5"

function buildResponsivenessBlock(sig) {
  if (!sig) return ""
  // first_contact w/o brief_inbound has nothing useful to add over standard
  // phase guidance — skip the block to keep the prompt tight.
  if (sig.state === "first_contact" && !sig.briefInbound) return ""
  const obParts = []
  if (sig.outbound.call) obParts.push(`${sig.outbound.call} call/voicemail`)
  if (sig.outbound.imessage) obParts.push(`${sig.outbound.imessage} text`)
  if (sig.outbound.email) obParts.push(`${sig.outbound.email} email`)
  const inboundDesc = sig.responsesSinceFirstOutbound > 0
    ? `${sig.responsesSinceFirstOutbound} reply (${sig.daysSinceLastResponse}d ago)`
    : sig.inboundTotal > 0
    ? `${sig.inboundTotal} initial inbound${sig.briefInbound ? " (brief)" : ""}, no reply since`
    : "no reply"
  return `
RESPONSIVENESS (last 30 days):
- Ryan's outreach: ${obParts.join(", ") || "none"}
- Lead's response: ${inboundDesc}
- State: ${sig.state}${sig.briefInbound ? " (brief inbound)" : ""}
`
}

function phaseGuidanceFor(touchNumber, sig) {
  // Responsiveness overrides the touch-number phase — when the lead has gone
  // dark, the right message isn't "low-pressure availability check", it's a
  // warm reach-out that acknowledges the silence.
  if (sig && sig.state === "never_responded" && sig.outboundTotal >= 1) {
    return `UNRESPONSIVE — Ryan has reached out ${sig.outboundTotal}x and the lead hasn't responded. Acknowledge you've been trying to connect, no pressure. Examples of the tone: "Hey, just wanted to check in", "Let me know if there's anything I can do to help, otherwise I'll leave you be". Leave the door open without pushing. Do NOT ask a clarifying question and do NOT imply the lead reached out to you.`
  }
  if (sig && sig.state === "gone_quiet") {
    return `GONE QUIET — they responded earlier but the conversation died ${sig.daysSinceLastResponse}d ago. Warm, brief check-in, no recap, no re-ask of an old question. Acknowledge the gap and offer to help. Same tone as UNRESPONSIVE but you can reference that you talked before.`
  }
  // Brief initial inbound — lead reached out (call/voicemail/text) but the
  // content was too thin to interpret intent. Standard touch #1 ("just
  // following up on the letter") doesn't fit because it assumes we know
  // what they want. Drift to an acknowledge-and-ask pattern.
  if (sig && sig.briefInbound && touchNumber === 1) {
    const inboundDesc = sig.lastInboundKind === "call"
      ? "missed call and voicemail"
      : sig.lastInboundKind === "sms"
      ? "text"
      : sig.lastInboundKind === "email"
      ? "email"
      : "voicemail"
    return `AMBIGUOUS INITIAL CONTACT — the lead reached out via ${inboundDesc} but their message was too brief to know what they want (e.g. just "thank you" or an empty voicemail). Acknowledge that you saw the ${inboundDesc} from this number, then ASK if they were reaching out about a letter you sent. Example tone: "Hi — got a missed call and voicemail from this number. Were you reaching out about a letter I sent you?". Keep it warm, no assumptions about intent.`
  }
  return touchNumber <= 3
    ? "early — low pressure, availability check, no aggressive close"
    : touchNumber <= 6
    ? "mid — value prop: cash, fast close (2-3 wks), no repairs, no commissions, no showings"
    : "long-tail — staying on radar, seasonal market angle, simple check-in"
}

function buildSystemPrompt(args) {
  const { lead, campaign, touchNumber, channel, history, clarify, daysSinceCreated, responsiveness } = args
  const isGoogleAds = campaign.type.startsWith("google_ads")
  const isLongTermNurture = campaign.type === "long_term_nurture"
  const phaseGuidance = phaseGuidanceFor(touchNumber, responsiveness)
  const responsivenessBlock = buildResponsivenessBlock(responsiveness)
  const isUnresponsive = responsiveness && (responsiveness.state === "never_responded" || responsiveness.state === "gone_quiet")

  const channelLine = channel === "email"
    ? "Format: email. 2-5 sentences. Sign off only with — Ryan. No subject in body. No emojis."
    : "Format: text message (iMessage). 1-3 sentences. No sign-off. No emojis. Sound like a real person texted this."

  // Suppress the clarify-question turn when the lead has gone unresponsive —
  // pestering them with another question is the wrong move.
  const clarifyClause = clarify && !isUnresponsive
    ? "\nQUALIFYING TURN: instead of a standard follow-up, ask ONE natural clarifying question (e.g. property location, ownership, timing). Keep it conversational, not interrogative."
    : ""

  // Anti-hallucination rule. Haiku reads the PRIOR CONVERSATION transcripts
  // and confidently writes "Got your voicemail" / "Got your missed call"
  // even when those transcripts are Ryan's OUTBOUND voicemails (the
  // recording captured the lead's outgoing greeting at the start). When the
  // lead is silent, we forbid the whole class of "you reached out" phrasing.
  const directionRule = isUnresponsive
    ? `\n- DIRECTION: Ryan is the active party reaching out. The lead is silent — do NOT reference any past message, call, or voicemail from the lead, even if the conversation history mentions a voicemail (those are Ryan's outbound voicemails to the lead — the lead's greeting was captured in the recording). Forbidden phrases: "Got your missed call", "Got your voicemail", "Saw you reached out", "Thanks for getting back to me", "Returning your call", "Following up on your message". Frame everything as Ryan's effort to connect with them.`
    : ""

  // Long-term nurture — for leads who explicitly said "not now, maybe in a
  // year or two". The whole point is patience: a soft seasonal check-in, no
  // sales push, no question about timing (they already told us). Tone is
  // closer to "thinking of you" than "follow up on the letter". Never
  // mention the original mailer or treat them like a fresh lead — they're
  // someone Ryan has already had a real conversation with.
  if (isLongTermNurture) {
    return `You are writing a ${channel === "email" ? "soft check-in email" : "soft check-in text"} from Ryan, a cash home buyer in the Bay Area, to a lead Ryan already spoke with who said they're not ready to sell yet (typically a 1-2 year horizon).

RULES:
- Sound like a real person ${channel === "email" ? "wrote this" : "texted this"}. Warm, brief, no sales push.
- This is NOT a first contact. Do NOT reference a letter or treat them like a new lead.
- Do NOT ask about timing or readiness — they already told you they're not ready. Asking again is the wrong move.
- Goal is to stay in their orbit so they think of you when the time IS right. No clarifying questions, no value-prop pitch.
- ${channelLine}${directionRule}

PHASE GUIDANCE: long-term nurture touch #${touchNumber}. ${touchNumber === 1
      ? "First soft check-in, ~60 days after you last spoke. Brief 'how's the year going' or seasonal angle. No ask."
      : touchNumber <= 4
      ? "Quarterly seasonal check-in. Reference the season or a generic life event (new year, holidays, spring) where natural. Keep it short."
      : touchNumber === 5
      ? "Anniversary check-in (~1 year). 'It's been about a year since we talked' is fine. Still no ask."
      : "1.5+ year check-in. Light touch, possibly mention you're still around if the timing ever becomes right."}
${responsivenessBlock}
LEAD CONTEXT:
- Name: ${lead.name || "(unknown)"}
- Property: ${lead.property_address || "(unknown)"}
- Touch number: ${touchNumber}
- Days since first contact: ${daysSinceCreated}

PRIOR CONVERSATION (oldest → newest):
${history || "(no prior conversation)"}

Output ONLY the message body — no preamble, no quotes, no labels.`
  }

  if (isGoogleAds) {
    return `You are writing a ${channel === "email" ? "follow-up email" : "follow-up text message"} from Ryan, a cash home buyer in the Bay Area, to a lead who filled out a form online about selling their property.

RULES:
- Sound like a real person ${channel === "email" ? "wrote this email" : "texted this"}. Short, casual, no filler.
- Never use "newsletter" tone or templated subject-verb-object patterns.
- Never repeat an opener from prior touches (conversation history is below).
- ${channelLine}${directionRule}

PHASE GUIDANCE: ${phaseGuidance}
${clarifyClause}
${responsivenessBlock}
LEAD CONTEXT:
- Name: ${lead.name || "(unknown)"}
- Property: ${lead.property_address || "(unknown)"}
- Form submitted: ${lead.created_at}
- Touch number: ${touchNumber}
- Days since first contact: ${daysSinceCreated}

PRIOR CONVERSATION (oldest → newest, may be empty):
${history || "(no prior conversation)"}

Output ONLY the message body — no preamble, no quotes, no labels.`
  }

  // Direct mail
  return `You are writing a ${channel === "email" ? "follow-up email" : "follow-up text message"} from Ryan, a cash home buyer in the Bay Area, to a lead who received a physical letter and reached out (call/voicemail/sms/email).

RULES:
- Sound like a real person ${channel === "email" ? "wrote this email" : "texted this"}. Short, casual, no filler.
- Reference the letter they received where natural.
- Goal is to get them on a phone call — not to close digitally.
- Never repeat an opener from prior touches (conversation history below).
- ${channelLine}${directionRule}

PHASE GUIDANCE: ${phaseGuidance}
${clarifyClause}
${responsivenessBlock}
LEAD CONTEXT:
- Name: ${lead.name || "(unknown)"}
- Property: ${lead.property_address || "(unknown — ask naturally if relevant)"}
- Entry method: ${lead.lead_type || "(unknown)"}
- Touch number: ${touchNumber}
- Days since first contact: ${daysSinceCreated}

PRIOR CONVERSATION (oldest → newest, may be empty):
${history || "(no prior conversation)"}

Output ONLY the message body — no preamble, no quotes, no labels.`
}

async function generateMessage(args) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.warn("[drip] OPENROUTER_API_KEY not set — skipping generation")
    return null
  }
  const systemPrompt = buildSystemPrompt(args)
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 250,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Generate touch #${args.touchNumber} for this lead.` },
        ],
      }),
    })
    if (!res.ok) {
      console.error(`[drip] OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`)
      return null
    }
    const json = await res.json()
    const text = json?.choices?.[0]?.message?.content?.trim() || ""
    if (!text) return null
    return text.replace(/^["'`]+|["'`]+$/g, "").trim()
  } catch (e) {
    console.error("[drip] generation threw:", e.message)
    return null
  }
}

// Special touch 0 for missed calls — fixed copy, no Haiku call.
function missedCallTouch0Body() {
  return "Hey, this is Ryan — I had a missed call from this number. Can I help you?"
}

// ─── senders ────────────────────────────────────────────────────────────────

async function sendIMessage(phone, message) {
  const res = await fetch(`${SIDECAR_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, message }),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => "")
    throw new Error(`sidecar send ${res.status}: ${txt.slice(0, 200)}`)
  }
  return res.json().catch(() => ({}))
}

function getGmailClient(userEmail) {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set")
  const credentials = JSON.parse(key)
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    subject: userEmail,
  })
  return google.gmail({ version: "v1", auth })
}

function buildRawEmail({ to, from, subject, body, inReplyTo, references }) {
  const lines = [`To: ${to}`, `From: ${from}`, `Subject: ${subject}`]
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`)
  if (references && references.length > 0) lines.push(`References: ${references.join(" ")}`)
  else if (inReplyTo) lines.push(`References: ${inReplyTo}`)
  lines.push("MIME-Version: 1.0")
  lines.push("Content-Type: text/plain; charset=UTF-8")
  lines.push("")
  lines.push(body)
  return Buffer.from(lines.join("\r\n")).toString("base64url")
}

async function sendDripEmail({ lead, body, subject }) {
  if (!lead.email) throw new Error("lead has no email address")
  // Send-from rule:
  //   1. If the lead came in via email (twilio_number = "email:<mailbox>"),
  //      reply from the same mailbox so the Gmail thread stays consistent.
  //   2. Else if source_type === "google_ads", send from info@lrghomes.com —
  //      that's the same address lrghomes-landing/api/submit-lead.js uses
  //      for the touch-0 confirmation email, so the form lead sees one
  //      continuous thread instead of two senders.
  //   3. Else (direct mail without an inbox, e.g. call/sms upgrades), fall
  //      back to DRIP_DEFAULT_MAILBOX or ryan@lrghomes.com.
  const fromMailbox = (() => {
    if (lead.twilio_number && String(lead.twilio_number).startsWith("email:")) {
      return String(lead.twilio_number).slice("email:".length)
    }
    if (lead.source_type === "google_ads") {
      return "info@lrghomes.com"
    }
    return process.env.DRIP_DEFAULT_MAILBOX || "ryan@lrghomes.com"
  })()
  const gmail = getGmailClient(fromMailbox)

  let inReplyTo = null
  let referencesChain = []
  if (lead.gmail_thread_id) {
    try {
      const { data: thread } = await gmail.users.threads.get({
        userId: "me",
        id: lead.gmail_thread_id,
        format: "metadata",
        metadataHeaders: ["Message-Id"],
      })
      const msgIds = []
      for (const m of thread.messages || []) {
        const headers = m.payload?.headers || []
        const idHdr = headers.find((h) => (h.name || "").toLowerCase() === "message-id")
        if (idHdr?.value) msgIds.push(idHdr.value.trim())
      }
      if (msgIds.length > 0) {
        inReplyTo = msgIds[msgIds.length - 1]
        referencesChain = msgIds
      }
    } catch (e) {
      console.warn("[drip] thread metadata fetch failed:", e.message)
    }
  }

  const raw = buildRawEmail({
    to: lead.email,
    from: fromMailbox,
    subject,
    body,
    inReplyTo,
    references: referencesChain,
  })
  const requestBody = { raw }
  if (lead.gmail_thread_id) requestBody.threadId = lead.gmail_thread_id
  const { data } = await gmail.users.messages.send({ userId: "me", requestBody })
  return { mailbox: fromMailbox, messageId: data.id || null }
}

// ─── telegram ───────────────────────────────────────────────────────────────

async function sendTelegram(text) {
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
    console.warn("[drip] telegram failed:", e.message)
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))
}

// ─── main passes ────────────────────────────────────────────────────────────

async function drainApprovedQueue(sb) {
  const { data: approved, error } = await sb
    .from("drip_queue")
    .select("*")
    .eq("status", "approved")
    .order("created_at", { ascending: true })
    .limit(50)
  if (error) {
    console.error("[drip] drain query failed:", error.message)
    return
  }
  if (!approved || approved.length === 0) return
  console.log(`[drip] draining ${approved.length} approved queue row(s)`)
  for (const q of approved) {
    if (DRY_RUN) {
      console.log(`[drip] DRY-RUN would send queue ${q.id} → lead ${q.lead_id} (${q.channel})`)
      continue
    }
    const { data: lead, error: leadErr } = await sb
      .from("leads")
      .select("*")
      .eq("id", q.lead_id)
      .maybeSingle()
    if (leadErr || !lead) {
      console.warn(`[drip] queue ${q.id}: lead fetch failed`)
      await sb.from("drip_queue").update({ status: "failed", error: "lead_not_found" }).eq("id", q.id)
      continue
    }
    try {
      await sendDripTouch({ lead, channel: q.channel, message: q.message, subject: q.subject, sb, queueRow: q })
      const sentAt = new Date().toISOString()
      await sb.from("drip_queue").update({ status: "sent", sent_at: sentAt }).eq("id", q.id)
      // Cadence clock: bump `last_drip_sent_at` to the ACTUAL send timestamp.
      // This is what guards the next-touch delay — without this update the
      // engine would still be using the stale queue-time stamp (or worse,
      // nothing at all, leading to "touch N+1 due immediately" loops).
      await sb.from("leads").update({ last_drip_sent_at: sentAt }).eq("id", q.lead_id)
      console.log(`[drip] sent queue ${q.id} → ${q.channel} → ${lead.id}`)
    } catch (e) {
      console.error(`[drip] queue ${q.id} send failed:`, e.message)
      await sb.from("drip_queue").update({ status: "failed", error: e.message }).eq("id", q.id)
    }
  }
}

// Send + log a drip touch. Used both by drainApprovedQueue (after Ryan
// approves) and by directSend (auto-send mode bypassing the queue).
async function sendDripTouch({ lead, channel, message, subject, sb, queueRow }) {
  if (channel === "imessage") {
    if (!lead.caller_phone) throw new Error("no phone")
    await sendIMessage(lead.caller_phone, message)
  } else if (channel === "email") {
    const subj = subject || dripEmailSubject(lead)
    await sendDripEmail({ lead, body: message, subject: subj })
  } else {
    throw new Error(`unknown channel ${channel}`)
  }

  // Log a row in the leads table marked as a drip-sent event.
  const dripLeadType = channel === "imessage" ? "drip_imessage" : "drip_email"
  const { error: insErr } = await sb.from("leads").insert({
    source: lead.source,
    source_type: lead.source_type,
    twilio_number: null, // outbound
    caller_phone: lead.caller_phone,
    lead_type: dripLeadType,
    message,
    status: lead.status, // do NOT change status from a drip
    name: lead.name,
    email: lead.email,
    property_address: lead.property_address,
    gmail_thread_id: channel === "email" ? lead.gmail_thread_id : null,
  })
  if (insErr) console.warn(`[drip] event row insert failed for lead ${lead.id}:`, insErr.message)
}

function dripEmailSubject(lead) {
  // Reply path: stay on the existing thread's subject if we know it.
  const original = (lead.message || "").split(/\r?\n/, 1)[0].trim()
  if (original) {
    return /^re:\s/i.test(original) ? original : `Re: ${original}`
  }
  if (lead.property_address) return `Quick follow-up about ${lead.property_address}`
  return "Quick follow-up"
}

// Fetch all leads currently eligible for drip processing.
async function fetchEligibleLeads(sb) {
  let q = sb
    .from("leads")
    .select("*")
    .not("drip_campaign_type", "is", null)
    .not("status", "in", `(${[...DRIP_STOP_STATUSES].join(",")})`)
    // Phase 7C flag gates. `eq("is_dnc", false)` also includes NULL rows in
    // PostgREST (NULL ≠ false → filtered out), so the migration's DEFAULT
    // false on these columns is what keeps legacy rows in scope.
    .eq("is_dnc", false)
    .eq("is_junk", false)
    .order("last_drip_sent_at", { ascending: true })
    .limit(500)
  if (LEAD_FILTER_ID) q = q.eq("id", LEAD_FILTER_ID)
  const { data, error } = await q
  if (error) {
    console.error("[drip] eligible-lead query failed:", error.message)
    return []
  }
  // Cluster dedupe: when a cluster (same phone OR email OR gmail thread)
  // has multiple stamped rows, the engine MUST pick exactly one driver or
  // it'll queue parallel touches per row (the Brian Bernasconi pattern).
  // Mirror lib/leads.ts `dedupeClusterStamps` winner-selection rules:
  // engine-touched > highest touch_number > most-recent last_drip_sent_at >
  // most-recent created_at. Losers are skipped (not un-stamped — the
  // backfill script does the durable cleanup; this is just defense in
  // depth so a transient race or future regression can't put us back into
  // the duplicate-queue hole).
  return dedupeByCluster(data || [])
}

function clusterKey(lead) {
  if (lead.caller_phone && lead.caller_phone !== "Anonymous") return `phone:${lead.caller_phone}`
  if (lead.gmail_thread_id) return `thread:${lead.gmail_thread_id}`
  if (lead.email) return `email:${(lead.email || "").toLowerCase()}`
  return `id:${lead.id}`
}

// Mirrors pickClusterWinner in lib/leads.ts — keep in sync. Two-stage
// pick so a user-applied campaign change wins over a sibling row with
// higher touch progress on the old campaign.
function pickClusterWinner(rows) {
  if (rows.length === 1) return rows[0]
  const byCampaign = new Map()
  for (const r of rows) {
    const k = r.drip_campaign_type || "__null__"
    if (!byCampaign.has(k)) byCampaign.set(k, [])
    byCampaign.get(k).push(r)
  }
  let winningCampaign = null
  let bestActionTs = -Infinity
  byCampaign.forEach((crows, campaign) => {
    const maxTs = Math.max(...crows.map(r =>
      r.last_drip_sent_at ? new Date(r.last_drip_sent_at).getTime() : new Date(r.created_at).getTime()
    ))
    if (maxTs > bestActionTs) { bestActionTs = maxTs; winningCampaign = campaign }
  })
  const pool = byCampaign.get(winningCampaign)
  return pool.slice().sort((a, b) => {
    const aT = a.last_drip_sent_at != null
    const bT = b.last_drip_sent_at != null
    if (aT !== bT) return bT ? 1 : -1
    const aN = a.drip_touch_number ?? 0
    const bN = b.drip_touch_number ?? 0
    if (aN !== bN) return bN - aN
    const aL = a.last_drip_sent_at ? new Date(a.last_drip_sent_at).getTime() : 0
    const bL = b.last_drip_sent_at ? new Date(b.last_drip_sent_at).getTime() : 0
    if (aL !== bL) return bL - aL
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })[0]
}

function dedupeByCluster(leads) {
  const byCluster = new Map()
  for (const lead of leads) {
    const key = clusterKey(lead)
    if (!byCluster.has(key)) byCluster.set(key, [])
    byCluster.get(key).push(lead)
  }
  const winners = []
  let dropped = 0
  byCluster.forEach((rows) => {
    const w = pickClusterWinner(rows)
    winners.push(w)
    dropped += rows.length - 1
  })
  if (dropped > 0) console.log(`[drip] cluster dedupe dropped ${dropped} duplicate-stamp row(s) — see scripts/backfill-dedupe-cluster-stamps for the durable fix`)
  return winners
}

// Has this lead got a queued (pending) drip already? If yes we don't queue
// another touch — the previous one is awaiting Ryan's approval.
async function hasPendingQueueRow(sb, leadId) {
  const { data, error } = await sb
    .from("drip_queue")
    .select("id")
    .eq("lead_id", leadId)
    .in("status", ["pending", "approved"])
    .limit(1)
  if (error) return false
  return (data || []).length > 0
}

// Returns true if this lead has had any real (non-drip) interaction.
// Drip rows have lead_type prefixed with "drip_". Anything else means
// we've already engaged — "I missed your call" is the wrong opener.
async function hasPriorNonDripEvent(sb, lead) {
  let q = sb.from("leads").select("id, lead_type").limit(50)
  if (lead.caller_phone)    q = q.eq("caller_phone", lead.caller_phone)
  else if (lead.email)      q = q.eq("email", lead.email)
  else                      q = q.eq("id", lead.id)
  const { data, error } = await q
  if (error) {
    console.warn(`[drip] prior-contact query failed for ${lead.id}:`, error.message)
    return false
  }
  for (const row of data || []) {
    if (!row.lead_type) continue
    if (row.lead_type.startsWith("drip_")) continue
    // Seed row for a true missed call is fine — let that through.
    if (row.lead_type === "missed_call") continue
    return true
  }
  return false
}

// Apply the campaign-upgrade rule: when a phone arrives on an email-only
// lead, switch its drip_campaign_type so the next touch can use iMessage.
async function maybeUpgradeCampaign(sb, lead) {
  if (!lead.caller_phone) return lead
  if (lead.drip_campaign_type === "google_ads_email_only") {
    await sb.from("leads").update({ drip_campaign_type: "google_ads_form" }).eq("id", lead.id)
    return { ...lead, drip_campaign_type: "google_ads_form" }
  }
  // direct_mail_email stays as direct_mail_email but channel parity flips
  // when phone is present (handled by effectiveChannel). No DB update.
  return lead
}

async function processLead(sb, lead) {
  // Stop conditions baked into the SQL filter, but re-check defensively.
  if (DRIP_STOP_STATUSES.has(lead.status)) return { skipped: "stop_status" }
  if (await hasPendingQueueRow(sb, lead.id)) return { skipped: "pending_queued" }

  lead = await maybeUpgradeCampaign(sb, lead)
  const campaign = DRIP_CAMPAIGNS[lead.drip_campaign_type]
  if (!campaign) return { skipped: "unknown_campaign" }

  // Direct mail call: special touch 0 (15-min missed-call message) only when
  // recording_url is null AND drip_touch_number is NULL (truly fresh).
  // NULL check is critical: once touch #0 fires we write drip_touch_number=0,
  // and 0 must NOT be treated as "fresh" on the next pass — that was the loop bug.
  let isMissedCall = campaign.type === "direct_mail_call"
    && lead.drip_touch_number == null
    && !lead.recording_url

  // If we'd send touch #0, confirm there's no prior real contact first.
  if (isMissedCall) {
    const hasPriorContact = await hasPriorNonDripEvent(sb, lead)
    if (hasPriorContact) {
      console.log(`[drip] lead ${lead.id} has prior non-drip activity — skipping touch #0`)
      isMissedCall = false
    }
  }

  let nextTouch
  if (isMissedCall) {
    const ageMs = Date.now() - new Date(lead.created_at).getTime()
    if (ageMs < 15 * 60 * 1000) return { skipped: "missed_call_buffer" }
    nextTouch = campaign.touches.find((t) => t.touchNumber === 0)
  } else {
    const startedFrom = lead.drip_touch_number ?? -1
    const baseTouch = startedFrom < 0 ? 0 : startedFrom
    nextTouch = campaign.touches.find((t) => t.touchNumber > baseTouch)
  }

  if (!nextTouch) return { skipped: "no_more_touches" }

  // Enforce the entry delay for the very first touch.
  const sinceLast = lead.last_drip_sent_at
    ? Date.now() - new Date(lead.last_drip_sent_at).getTime()
    : Infinity
  const requiredMs = nextTouch.delayHours * 3600 * 1000
  // Voicemail leads need entryDelayHours before touch 1 fires.
  const entryHoldMs = (lead.drip_touch_number == null || (lead.drip_touch_number ?? 0) === 0)
    && !isMissedCall
    && nextTouch.touchNumber === 1
    ? Math.max(requiredMs, campaign.entryDelayHours * 3600 * 1000)
    : requiredMs
  if (sinceLast < entryHoldMs) {
    return { skipped: `not_due (need ${(entryHoldMs - sinceLast) / 3600000 | 0}h more)` }
  }

  // HOLD if there's been activity in the conversation since last touch.
  const activity = await hasActiveConversation(lead, sb)
  if (activity.hold) {
    // Reset clock so subsequent touches give the human conversation space.
    await sb.from("leads").update({ last_drip_sent_at: new Date().toISOString() }).eq("id", lead.id)
    return { skipped: `hold:${activity.reason}` }
  }

  const history = await buildConversationHistory(lead, sb)
  const responsiveness = await extractResponsivenessSignals(lead, sb)
  const hardStop = detectHardStop(history)
  if (hardStop) {
    console.log(`[drip] HARD STOP lead ${lead.id}: matched "${hardStop}" — flagging DNC + dead`)
    // Phase 7C: hard-stop trigger now sets the is_dnc flag (which halts every
    // outreach channel) and bumps the lifecycle to "dead". The auto-DNC also
    // tries to drop a row on dnc_list so the lead's address is suppressed for
    // future mailings; we pull whatever address fields are populated.
    await sb.from("leads").update({ status: "dead", is_dnc: true }).eq("id", lead.id)
    const { error: dncErr } = await sb.from("dnc_list").insert({
      site_address: lead.property_address || null,
      owner_name: lead.name || null,
      source_lead_id: lead.id,
      reason: "hostile",
      added_by: "system",
    })
    if (dncErr) console.warn(`[drip] dnc_list insert failed:`, dncErr.message)
    await sendTelegram(`🛑 Drip auto-stopped — lead <code>${escapeHtml(lead.id)}</code> hit DNC trigger: <i>${escapeHtml(hardStop)}</i>`)
    return { skipped: "hard_stop" }
  }
  const softReasons = detectSoftSignals(lead, history)
  const clarify = softReasons.length > 0

  // Phase 7C: bad-number rerouting. If the chosen channel is iMessage but
  // the lead is flagged is_bad_number, walk forward to the first email
  // touch in the campaign. If the campaign has no email touches left,
  // halt — there's nothing we can send.
  let activeTouch = nextTouch
  let activeChannel = effectiveChannel(campaign, activeTouch.touchNumber, !!lead.caller_phone)
  if (lead.is_bad_number && activeChannel === "imessage") {
    const emailTouch = campaign.touches.find(
      (t) => t.touchNumber > activeTouch.touchNumber && t.channel === "email"
    )
    if (!emailTouch) {
      return { skipped: "bad_number_no_email_remaining" }
    }
    activeTouch = emailTouch
    activeChannel = "email"
    console.log(`[drip] is_bad_number=true on ${lead.id} — skipping to email touch #${activeTouch.touchNumber}`)
  }

  // Special-case missed-call touch 0 — fixed copy, no Haiku.
  let messageBody
  if (isMissedCall && activeTouch.touchNumber === 0) {
    messageBody = missedCallTouch0Body()
  } else {
    const daysSinceCreated = Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86400000)
    messageBody = await generateMessage({
      lead,
      campaign,
      touchNumber: activeTouch.touchNumber,
      channel: activeChannel,
      history,
      clarify,
      daysSinceCreated,
      responsiveness,
    })
  }
  if (!messageBody) return { skipped: "generation_failed" }

  const channel = activeChannel
  // Channel guards — skip if we can't actually send. e.g. email-only campaign
  // but the lead has no email address (rare but possible if the address was
  // manually cleared from the row).
  if (channel === "email" && !lead.email) return { skipped: "channel_email_no_address" }
  if (channel === "imessage" && !lead.caller_phone) return { skipped: "channel_imessage_no_phone" }

  const subject = channel === "email" ? dripEmailSubject(lead) : null

  if (DRY_RUN) {
    console.log(`[drip] DRY-RUN lead ${lead.id} touch #${activeTouch.touchNumber} (${channel}):\n${messageBody}\n`)
    return { processed: true, dryRun: true }
  }

  // Advance `drip_touch_number` immediately so the next engine pass knows
  // which touch is "in flight" and `hasPendingQueueRow` keeps the queue
  // monogamous — but DO NOT touch `last_drip_sent_at` here. That field
  // is the cadence clock: it has to reflect the actual send timestamp,
  // not the queue timestamp. Setting it at queue-time caused drips that
  // sat in the approval queue for days to falsely "age" the lead — the
  // moment Ryan clicked Send, the engine saw `last_drip_sent_at` as days
  // old, decided the next-touch cadence had already elapsed, and queued
  // touch #N+1 instantly. The actual send-time update now lives in
  // `drainApprovedQueue` (queued path) and the AUTO_SEND branch below.
  await sb
    .from("leads")
    .update({ drip_touch_number: activeTouch.touchNumber })
    .eq("id", lead.id)

  if (AUTO_SEND) {
    try {
      await sendDripTouch({ lead, channel, message: messageBody, subject, sb })
      // Auto-send fires immediately — record the actual send time so the
      // cadence clock starts here, not at the (theoretical) queue time.
      await sb.from("leads").update({ last_drip_sent_at: new Date().toISOString() }).eq("id", lead.id)
      console.log(`[drip] AUTO-SENT lead ${lead.id} touch #${activeTouch.touchNumber} (${channel})`)
      return { processed: true, autoSent: true }
    } catch (e) {
      console.error(`[drip] auto-send failed for ${lead.id}:`, e.message)
      await sendTelegram(`⚠️ Drip auto-send FAILED — lead <code>${escapeHtml(lead.id)}</code>: ${escapeHtml(e.message)}`)
      return { error: e.message }
    }
  }

  // Queue + Telegram approval gate.
  const { data: queued, error: qErr } = await sb
    .from("drip_queue")
    .insert({
      lead_id: lead.id,
      touch_number: activeTouch.touchNumber,
      campaign_type: campaign.type,
      channel,
      message: messageBody,
      subject: subject || null,
      status: "pending",
    })
    .select("id")
    .single()
  if (qErr) {
    console.error(`[drip] queue insert failed for ${lead.id}:`, qErr.message)
    return { error: qErr.message }
  }

  const preview = messageBody.length > 600 ? messageBody.slice(0, 600) + "…" : messageBody
  const channelLabel = channel === "imessage" ? "iMessage" : "Email"
  const recipient = lead.name || lead.caller_phone || lead.email || lead.id
  const lines = [
    `🔄 Drip #${activeTouch.touchNumber} — <b>${escapeHtml(campaign.type)}</b>`,
    `Lead: ${escapeHtml(recipient)}`,
    `Channel: ${channelLabel}${clarify ? " · clarifying" : ""}`,
    "",
    `<i>${escapeHtml(preview)}</i>`,
    "",
    `Approve in Mission Control → /leads`,
  ]
  await sendTelegram(lines.join("\n"))
  console.log(`[drip] QUEUED lead ${lead.id} touch #${activeTouch.touchNumber} (${channel}) queue=${queued.id}`)
  return { processed: true, queued: queued.id }
}

async function main() {
  const startedAt = Date.now()
  console.log(`[drip] === pass start ${new Date().toISOString()} ===`)
  console.log(`[drip] mode=${AUTO_SEND ? "AUTO-SEND" : "APPROVAL-GATE"}${DRY_RUN ? " (DRY-RUN)" : ""}`)

  const sb = getSupabase()

  if (!DRY_RUN) {
    await drainApprovedQueue(sb)
  }

  const leads = await fetchEligibleLeads(sb)
  console.log(`[drip] ${leads.length} eligible lead(s)`)

  let processed = 0
  let skipped = 0
  let errored = 0
  const skipReasons = {}
  for (const lead of leads) {
    try {
      const result = await processLead(sb, lead)
      if (result.error) {
        errored++
      } else if (result.processed) {
        processed++
      } else if (result.skipped) {
        skipped++
        skipReasons[result.skipped] = (skipReasons[result.skipped] || 0) + 1
      }
    } catch (e) {
      errored++
      console.error(`[drip] lead ${lead.id} threw:`, e.message)
    }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  console.log(`[drip] === pass done in ${elapsed}s — processed=${processed} skipped=${skipped} errored=${errored} ===`)
  if (skipped > 0) {
    console.log(`[drip] skip reasons:`, skipReasons)
  }
}

// Exports for one-shot helpers (e.g. scripts/regenerate-pending-drips.js)
// that want to re-use the engine's prompt + signal helpers without running
// the full hourly pass.
module.exports = {
  DRIP_CAMPAIGNS,
  buildConversationHistory,
  extractResponsivenessSignals,
  generateMessage,
  buildSystemPrompt,
}

// Skip the hourly main() when imported by a helper script — set by
// scripts/regenerate-pending-drips.js before the require().
if (!process.env.DRIP_REGEN_SKIP_MAIN) {
  main().catch((e) => {
    console.error("[drip] fatal:", e)
    process.exit(1)
  })
}
