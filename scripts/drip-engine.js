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

const DIRECT_MAIL_CALL_TOUCHES = [
  { touchNumber: 0, delayHours: 0.25, channel: "imessage" }, // missed-call only
  ...ALL_IMESSAGE(GOOGLE_ADS_FORM_TOUCHES),
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
}

const DRIP_STOP_STATUSES = new Set(["active", "junk", "do_not_contact"])

// When an email-only campaign acquires a phone, alternate channels by
// touch parity (odd → iMessage, even → email). Mirrors google_ads_form's
// pattern. Returns the original channel when phone is absent / N/A.
function effectiveChannel(campaign, touchNumber, hasPhone) {
  const defined = campaign.touches.find((t) => t.touchNumber === touchNumber)
  if ((campaign.type === "direct_mail_email" || campaign.type === "google_ads_email_only") && hasPhone) {
    return touchNumber % 2 === 1 ? "imessage" : "email"
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
    const txt = (row.message || "").trim().slice(0, 300)
    if (!txt) continue
    lines.push(`[${row.created_at}] ${dir}: ${txt}`)
  }

  // chat.db tail — adds messages we haven't logged into Supabase yet.
  if (lead.caller_phone) {
    const msgs = await fetchIMessageHistory(lead.caller_phone)
    for (const m of msgs.slice(-20)) {
      const dir = m.is_from_me ? "ryan" : "lead"
      const ts = new Date(Number(m.timestamp) + APPLE_EPOCH_OFFSET_MS).toISOString()
      const txt = (m.text || "").trim().slice(0, 300)
      if (!txt) continue
      lines.push(`[${ts}] ${dir}(imsg): ${txt}`)
    }
  }
  return lines.join("\n")
}

// ─── junk filter (Part 8) ───────────────────────────────────────────────────

const HARD_STOP_PATTERNS = [
  /\btake me off\b/i,
  /\bstop texting\b/i,
  /\bstop messaging\b/i,
  /\bstop emailing\b/i,
  /\bdon'?t contact\b/i,
  /\bremove me\b/i,
  /\bnot interested\b/i,
  /\bwrong number\b/i,
  /\bfuck off\b/i,
  /\bleave me alone\b/i,
  /\bunsubscribe\b/i,
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

function buildSystemPrompt(args) {
  const { lead, campaign, touchNumber, channel, history, clarify, daysSinceCreated } = args
  const isGoogleAds = campaign.type.startsWith("google_ads")
  const phaseGuidance = touchNumber <= 3
    ? "early — low pressure, availability check, no aggressive close"
    : touchNumber <= 6
    ? "mid — value prop: cash, fast close (2-3 wks), no repairs, no commissions, no showings"
    : "long-tail — staying on radar, seasonal market angle, simple check-in"

  const channelLine = channel === "email"
    ? "Format: email. 2-5 sentences. Sign off only with — Ryan. No subject in body. No emojis."
    : "Format: text message (iMessage). 1-3 sentences. No sign-off. No emojis. Sound like a real person texted this."

  const clarifyClause = clarify
    ? "\nQUALIFYING TURN: instead of a standard follow-up, ask ONE natural clarifying question (e.g. property location, ownership, timing). Keep it conversational, not interrogative."
    : ""

  if (isGoogleAds) {
    return `You are writing a ${channel === "email" ? "follow-up email" : "follow-up text message"} from Ryan, a cash home buyer in the Bay Area, to a lead who filled out a form online about selling their property.

RULES:
- Sound like a real person ${channel === "email" ? "wrote this email" : "texted this"}. Short, casual, no filler.
- Never use "newsletter" tone or templated subject-verb-object patterns.
- Never repeat an opener from prior touches (conversation history is below).
- ${channelLine}

PHASE GUIDANCE: ${phaseGuidance}
${clarifyClause}

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
- ${channelLine}

PHASE GUIDANCE: ${phaseGuidance}
${clarifyClause}

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
  const res = await fetch(`${SIDECAR_URL}/api/crms/send`, {
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
      await sb.from("drip_queue").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", q.id)
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
    .order("last_drip_sent_at", { ascending: true })
    .limit(500)
  if (LEAD_FILTER_ID) q = q.eq("id", LEAD_FILTER_ID)
  const { data, error } = await q
  if (error) {
    console.error("[drip] eligible-lead query failed:", error.message)
    return []
  }
  return data || []
}

// Has this lead got a queued (pending) drip already? If yes we don't queue
// another touch — the previous one is awaiting Ryan's approval.
async function hasPendingQueueRow(sb, leadId) {
  const { data, error } = await sb
    .from("drip_queue")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "pending")
    .limit(1)
  if (error) return false
  return (data || []).length > 0
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
  // recording_url is null AND drip_touch_number = 0. Voicemail leads carry
  // recording_url and skip touch 0 — engine starts at touch 1 with 48h delay.
  const isMissedCall = campaign.type === "direct_mail_call"
    && (lead.drip_touch_number ?? 0) === 0
    && !lead.recording_url

  let nextTouch
  if (isMissedCall) {
    const ageMs = Date.now() - new Date(lead.created_at).getTime()
    if (ageMs < 15 * 60 * 1000) return { skipped: "missed_call_buffer" }
    nextTouch = campaign.touches.find((t) => t.touchNumber === 0)
  } else {
    // Voicemail leads (recording present) skip touch 0.
    const startedFrom = (lead.drip_touch_number ?? 0) === 0 && campaign.type === "direct_mail_call"
      ? 0 // they've now passed touch 0 implicitly
      : (lead.drip_touch_number ?? -1)
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
  const hardStop = detectHardStop(history)
  if (hardStop) {
    console.log(`[drip] HARD STOP lead ${lead.id}: matched "${hardStop}" — moving to do_not_contact`)
    await sb.from("leads").update({ status: "do_not_contact" }).eq("id", lead.id)
    await sendTelegram(`🛑 Drip auto-stopped — lead <code>${escapeHtml(lead.id)}</code> hit DNC trigger: <i>${escapeHtml(hardStop)}</i>`)
    return { skipped: "hard_stop" }
  }
  const softReasons = detectSoftSignals(lead, history)
  const clarify = softReasons.length > 0

  // Special-case missed-call touch 0 — fixed copy, no Haiku.
  let messageBody
  if (isMissedCall && nextTouch.touchNumber === 0) {
    messageBody = missedCallTouch0Body()
  } else {
    const channel = effectiveChannel(campaign, nextTouch.touchNumber, !!lead.caller_phone)
    const daysSinceCreated = Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86400000)
    messageBody = await generateMessage({
      lead,
      campaign,
      touchNumber: nextTouch.touchNumber,
      channel,
      history,
      clarify,
      daysSinceCreated,
    })
  }
  if (!messageBody) return { skipped: "generation_failed" }

  const channel = effectiveChannel(campaign, nextTouch.touchNumber, !!lead.caller_phone)
  // Channel guards — skip if we can't actually send. e.g. email-only campaign
  // but the lead has no email address (rare but possible if the address was
  // manually cleared from the row).
  if (channel === "email" && !lead.email) return { skipped: "channel_email_no_address" }
  if (channel === "imessage" && !lead.caller_phone) return { skipped: "channel_imessage_no_phone" }

  const subject = channel === "email" ? dripEmailSubject(lead) : null

  if (DRY_RUN) {
    console.log(`[drip] DRY-RUN lead ${lead.id} touch #${nextTouch.touchNumber} (${channel}):\n${messageBody}\n`)
    return { processed: true, dryRun: true }
  }

  // Advance the lead's drip counters NOW (whether queueing or auto-sending).
  // The brief: drip touches do NOT change status — only counter + timer.
  await sb
    .from("leads")
    .update({
      drip_touch_number: nextTouch.touchNumber,
      last_drip_sent_at: new Date().toISOString(),
    })
    .eq("id", lead.id)

  if (AUTO_SEND) {
    try {
      await sendDripTouch({ lead, channel, message: messageBody, subject, sb })
      console.log(`[drip] AUTO-SENT lead ${lead.id} touch #${nextTouch.touchNumber} (${channel})`)
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
      touch_number: nextTouch.touchNumber,
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
    `🔄 Drip #${nextTouch.touchNumber} — <b>${escapeHtml(campaign.type)}</b>`,
    `Lead: ${escapeHtml(recipient)}`,
    `Channel: ${channelLabel}${clarify ? " · clarifying" : ""}`,
    "",
    `<i>${escapeHtml(preview)}</i>`,
    "",
    `Approve in Mission Control → /leads`,
  ]
  await sendTelegram(lines.join("\n"))
  console.log(`[drip] QUEUED lead ${lead.id} touch #${nextTouch.touchNumber} (${channel}) queue=${queued.id}`)
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

main().catch((e) => {
  console.error("[drip] fatal:", e)
  process.exit(1)
})
