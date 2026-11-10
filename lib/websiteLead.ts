// Website leads are CALL-FIRST (Ryan, 2026-11-02 —
// briefs/BRIEF_WEBSITE_CALL_FIRST_2026-11-02.md). A form on lrghomes.com used
// to start a robot drip and text an alert to the Office — Info line, where it
// was dropped as our own number: Maryam Norton (fire-damaged Severance Ct)
// sat uncalled with no Telegram ping. Now:
//
//   intake  → lead row on the Website line, mailed-record match, Telegram
//             alert with a 📞 Call button, a short "calling you in a few
//             minutes" text (texts-OK only) and a confirmation email.
//   ladder  → three call attempts: right away, ~2h later, next morning.
//             Attempts are Ryan's outbound calls (card / Telegram Call
//             button) since the form; a call that connects ends it.
//   missed  → no answer / voicemail → a fixed "just tried you" text (email
//             when there's no text consent).
//   3 × no  → website_followup drip (4 approval-gated touches over 2 weeks),
//             then long-term nurture (drip engine hands off).
//
// Business hours are 8am–7pm Pacific, every day (Ryan calls weekends).
// The ladder state is DERIVED from the cluster's rows every time (no attempt
// counter to drift); only `website_ladder` (calling/done) and `ladder_pings`
// (which Telegram reminders went out) are stored, on the form row.

import type { SupabaseClient } from "@supabase/supabase-js"
import { completeText, hasLlmKey, SONNET } from "@/lib/llm"
import {
  WEBSITE_NUMBER,
  clusterHasDnc,
  getGmailClient,
  encodeEmailHeader,
  sendTelegramAlert,
  sendTwilioSms,
  type TelegramButton,
} from "@/lib/leads"

export const LEAD_CALL_CB_PREFIX = "lcall:"
export const WEBSITE_LINE_DISPLAY = "(650) 670-3914"
export const WEBSITE_MAILBOX = "info@lrghomes.com"
export const LADDER_ATTEMPTS = 3
// A connected call shorter than this was a voicemail / "call you back", not
// a conversation (same bar as Campaign Performance's Jackie test).
export const CONVERSATION_MIN_SEC = 60
export const REMINDER_AFTER_MS = 15 * 60 * 1000
export const SECOND_ATTEMPT_GAP_MS = 2 * 60 * 60 * 1000
export const LADDER_REASON_PREFIX = "Call attempt "
export const WEBSITE_FOLLOWUP_SMS = "website_followup"
export const WEBSITE_FOLLOWUP_EMAIL = "website_followup_email"

const TZ = "America/Los_Angeles"
const OPEN_HOUR = 8
const CLOSE_HOUR = 19
const MORNING_HOUR = 9

// ─── Pacific wall clock ──────────────────────────────────────────────────────

interface Wall { y: number; mo: number; d: number; h: number; mi: number }

function wallOf(at: Date): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute") }
}

// The instant whose Pacific wall clock reads y-mo-d h:00. Two passes settle
// the DST offset (the guess is off by at most the offset change).
function atWall(y: number, mo: number, d: number, h: number): Date {
  let t = Date.UTC(y, mo - 1, d, h)
  for (let i = 0; i < 2; i++) {
    const w = wallOf(new Date(t))
    const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi)
    t += Date.UTC(y, mo - 1, d, h) - asUtc
  }
  return new Date(t)
}

function addDays(w: Wall, n: number): Wall {
  const dt = new Date(Date.UTC(w.y, w.mo - 1, w.d + n))
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), h: 0, mi: 0 }
}

export function isBusinessHours(at: Date): boolean {
  const h = wallOf(at).h
  return h >= OPEN_HOUR && h < CLOSE_HOUR
}

/** `at` itself during business hours, else the next 8am Pacific. */
export function nextOpenAt(at: Date): Date {
  const w = wallOf(at)
  if (w.h >= OPEN_HOUR && w.h < CLOSE_HOUR) return at
  if (w.h < OPEN_HOUR) return atWall(w.y, w.mo, w.d, OPEN_HOUR)
  const n = addDays(w, 1)
  return atWall(n.y, n.mo, n.d, OPEN_HOUR)
}

/** 9am Pacific on the calendar day after `at`. */
export function nextMorningAt(at: Date): Date {
  const n = addDays(wallOf(at), 1)
  return atWall(n.y, n.mo, n.d, MORNING_HOUR)
}

export function pacificDate(at: Date): string {
  return at.toLocaleDateString("en-CA", { timeZone: TZ })
}

// ─── Ladder (pure) ───────────────────────────────────────────────────────────

export interface LadderRow {
  id: string
  created_at: string
  twilio_number: string | null
  lead_type: string | null
  call_duration_sec?: number | null
  call_conversation?: boolean | null
}

export type LadderState =
  | { phase: "calling"; attempt: number; dueAt: Date; callsMade: number; lastCallAt: Date | null }
  | { phase: "connected"; settled: boolean }
  | { phase: "engaged" }
  | { phase: "unreached"; callsMade: number }

// An outbound call row counts as an attempt once the lead's leg actually ran:
// /api/leads/call/status stamps call_conversation on every finished dial. A
// row with neither stamp nor talk time is a call where Ryan's own cell never
// answered — the lead was never dialed, so it isn't an attempt.
const isAttempt = (r: LadderRow) =>
  r.lead_type === "call" && !r.twilio_number &&
  (r.call_conversation === true || r.call_conversation === false || (r.call_duration_sec ?? 0) > 0)

/** Did this outbound call reach the lead? null = not known yet. */
export function callConnected(r: LadderRow): boolean | null {
  if (r.call_conversation === true) return true
  if (r.call_conversation === false) return false
  if ((r.call_duration_sec ?? 0) >= CONVERSATION_MIN_SEC) return null // long call, transcript still out
  return false
}

/**
 * Where a website lead's call ladder stands. `rows` = every row in the
 * contact's cluster (any order). Outbound calls placed since the form are the
 * attempts; any inbound row after the form (they called / texted / emailed
 * back) ends the ladder — the inbound paths alert Ryan on their own.
 */
// A long call still unclassified after this long (transcript pipeline died)
// is taken as a conversation — the safe direction: no "just tried you".
const UNSETTLED_GRACE_MS = 30 * 60 * 1000

export function computeLadder(form: { id: string; created_at: string }, rows: LadderRow[], now = new Date()): LadderState {
  const formAt = new Date(form.created_at).getTime()
  const after = rows
    .filter((r) => r.id !== form.id && new Date(r.created_at).getTime() >= formAt)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  if (after.some((r) => !!r.twilio_number && r.lead_type !== "form")) return { phase: "engaged" }

  const calls = after.filter(isAttempt)
  const verdicts = calls.map(callConnected)
  if (verdicts.some((v) => v === true)) return { phase: "connected", settled: true }
  if (verdicts.some((v) => v === null)) {
    const stale = calls.some((c, i) => verdicts[i] === null && now.getTime() - new Date(c.created_at).getTime() > UNSETTLED_GRACE_MS)
    return { phase: "connected", settled: stale }
  }

  const n = calls.length
  if (n >= LADDER_ATTEMPTS) return { phase: "unreached", callsMade: n }
  const lastCallAt = n ? new Date(calls[n - 1].created_at) : null
  let dueAt: Date
  if (!lastCallAt) dueAt = nextOpenAt(new Date(formAt))
  else if (n === 1) dueAt = nextOpenAt(new Date(lastCallAt.getTime() + SECOND_ATTEMPT_GAP_MS))
  else dueAt = nextMorningAt(lastCallAt)
  return { phase: "calling", attempt: n + 1, dueAt, callsMade: n, lastCallAt }
}

export function ladderReason(attempt: number): string {
  return `${LADDER_REASON_PREFIX}${attempt} of ${LADDER_ATTEMPTS} — website lead`
}

// ─── Copy ────────────────────────────────────────────────────────────────────

export function firstName(name: string | null | undefined): string {
  const f = (name || "").trim().split(/\s+/)[0] || ""
  return f ? f.charAt(0).toUpperCase() + f.slice(1) : ""
}

/** Street part of "5122 Severance Ct, San Jose, CA" → "Severance Ct". */
export function streetLabel(address: string | null | undefined): string | null {
  const first = (address || "").split(",")[0].trim()
  if (!first) return null
  const noNumber = first.replace(/^\d+[A-Za-z]?\s+/, "").trim()
  return noNumber || first
}

export function firstText(args: { name: string | null; address: string | null; inHours: boolean }): string {
  const hi = firstName(args.name) ? `Hi ${firstName(args.name)}, it's Ryan with LRG Homes.` : "Hi, it's Ryan with LRG Homes."
  const street = streetLabel(args.address)
  const got = street ? `Got your note about ${street}.` : "Got your note through our website."
  const when = args.inHours
    ? "I'll give you a call in the next few minutes."
    : "I'll give you a call first thing tomorrow morning."
  return `${hi} ${got} ${when}`
}

export function justTriedText(name: string | null): string {
  const f = firstName(name)
  return `${f ? `Hi ${f}, ` : "Hi, "}it's Ryan with LRG Homes. Just tried you. Call or text me back at ${WEBSITE_LINE_DISPLAY} whenever works.`
}

export function confirmationEmail(args: { name: string | null; address: string | null; inHours: boolean; isSeller: boolean }): { subject: string; body: string } {
  const f = firstName(args.name)
  const street = streetLabel(args.address)
  const lines = args.isSeller
    ? [
        `Hi ${f || "there"},`,
        "",
        `Thanks for reaching out${street ? ` about ${street}` : ""}. This is Ryan LaRocca with LRG Homes. ${args.inHours ? "I'll be calling you shortly" : "I'll give you a call first thing tomorrow morning"} at the number you gave us.`,
        "",
        "How it works:",
        "1. A short call so I understand the property and what you need.",
        "2. A cash offer in writing, usually within a day or two. We buy as-is, with no repairs, cleaning or showings.",
        "3. You pick the closing date. There are no commissions or fees.",
        "",
        "You can see a few of the houses we've bought at https://www.lrghomes.com.",
        "",
        `If it's easier, call or text me any time at ${WEBSITE_LINE_DISPLAY}.`,
      ]
    : [
        `Hi ${f || "there"},`,
        "",
        "Thanks for reaching out through lrghomes.com. This is Ryan LaRocca with LRG Homes. I got your note and will get back to you shortly.",
        "",
        `If it's easier, call or text me any time at ${WEBSITE_LINE_DISPLAY}.`,
      ]
  lines.push("", "Ryan LaRocca", "LRG Homes", WEBSITE_LINE_DISPLAY, "https://www.lrghomes.com")
  return { subject: f ? `Thanks for reaching out, ${f}` : "Thanks for reaching out", body: lines.join("\n") }
}

export function justTriedEmail(name: string | null): { subject: string; body: string } {
  const f = firstName(name)
  return {
    subject: "Just tried calling you",
    body: [
      `Hi ${f || "there"},`,
      "",
      `I just tried you by phone. Call or text me back at ${WEBSITE_LINE_DISPLAY} whenever works, or reply here with a good time to talk.`,
      "",
      "Ryan LaRocca",
      "LRG Homes",
      WEBSITE_LINE_DISPLAY,
    ].join("\n"),
  }
}

// ─── Sending (automatic messages — no manual-touch bookkeeping) ──────────────
// Automatic texts/emails are logged on the card but deliberately skip
// sendLeadSms' new→contacted promote and cadence reset: the lead stays New
// until Ryan actually calls.

export async function sendAutoText(
  sb: SupabaseClient,
  args: { phone: string; body: string; source: string | null }
): Promise<{ ok: boolean; error?: string }> {
  if (await clusterHasDnc(sb, { caller_phone: args.phone, email: null })) return { ok: false, error: "DNC" }
  try {
    const sent = await sendTwilioSms({ to: args.phone, body: args.body, preferredFrom: WEBSITE_NUMBER })
    if (sent.fellBack) console.warn(`[website-lead] text to ${args.phone} fell back to ${sent.from}`)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const { error } = await sb.from("leads").insert({
    source: args.source, source_type: "website", twilio_number: null,
    caller_phone: args.phone, lead_type: "sms", message: args.body, status: "contacted",
  })
  if (error) console.error("[website-lead] text log failed:", error.message)
  return { ok: true }
}

export async function sendAutoEmail(
  sb: SupabaseClient,
  args: { to: string; phone: string | null; name: string | null; address: string | null; subject: string; body: string; source: string | null }
): Promise<{ ok: boolean; error?: string }> {
  if (await clusterHasDnc(sb, { caller_phone: args.phone, email: args.to })) return { ok: false, error: "DNC" }
  try {
    const raw = Buffer.from([
      `To: ${args.to}`,
      `From: Ryan LaRocca | LRG Homes <${WEBSITE_MAILBOX}>`,
      `Subject: ${encodeEmailHeader(args.subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      args.body,
    ].join("\r\n")).toString("base64url")
    await getGmailClient(WEBSITE_MAILBOX).users.messages.send({ userId: "me", requestBody: { raw } })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const { error } = await sb.from("leads").insert({
    source: args.source, source_type: "website", twilio_number: null,
    caller_phone: args.phone, lead_type: "email", message: `${args.subject}\n\n${args.body}`,
    status: "contacted", name: args.name, email: args.to, property_address: args.address,
  })
  if (error) console.error("[website-lead] email log failed:", error.message)
  return { ok: true }
}

// ─── Telegram ────────────────────────────────────────────────────────────────

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function callButton(phone: string | null, label = "📞 Call"): TelegramButton[][] | undefined {
  const digits = (phone || "").replace(/\D/g, "").slice(-10)
  return digits.length === 10 ? [[{ text: label, data: `${LEAD_CALL_CB_PREFIX}${digits}` }]] : undefined
}

// Every website ping is about the lead at `phone`: recorded so a reply or
// "Draft:" to it finds them (lib/alertSubject).
export async function pingTelegram(text: string, phone: string | null): Promise<boolean> {
  const digits = (phone || "").replace(/\D/g, "").slice(-10)
  const about = digits.length === 10 ? { kind: "lead" as const, phone: `+1${digits}` } : null
  return sendTelegramAlert(text, { buttons: callButton(phone), about })
}

// ─── Ladder side effects ─────────────────────────────────────────────────────

export interface FormRow {
  id: string
  created_at: string
  caller_phone: string | null
  email: string | null
  name: string | null
  property_address: string | null
  source: string | null
  sms_consent: boolean | null
  website_ladder: string | null
  ladder_pings: Record<string, string> | null
  recommended_followup_date: string | null
  followup_reason: string | null
  is_dnc: boolean | null
  is_junk: boolean | null
  status: string | null
}

export const FORM_ROW_COLUMNS =
  "id, created_at, caller_phone, email, name, property_address, source, sms_consent, website_ladder, ladder_pings, recommended_followup_date, followup_reason, is_dnc, is_junk, status"

async function clusterRows(sb: SupabaseClient, form: FormRow): Promise<LadderRow[]> {
  const ors: string[] = []
  if (form.caller_phone) ors.push(`caller_phone.eq.${form.caller_phone}`)
  if (form.email) ors.push(`email.eq.${form.email.toLowerCase()}`)
  if (!ors.length) return []
  const { data, error } = await sb
    .from("leads")
    .select("id, created_at, twilio_number, lead_type, call_duration_sec, call_conversation")
    .or(ors.join(","))
    .gte("created_at", form.created_at)
    .limit(500)
  if (error) throw new Error(`cluster lookup failed: ${error.message}`)
  return (data ?? []) as LadderRow[]
}

/**
 * The website form row still running a ladder for this phone, if any — the
 * call status callback uses it to decide whether a missed call gets the
 * "just tried you" message.
 */
export async function activeLadderForPhone(sb: SupabaseClient, phone: string): Promise<FormRow | null> {
  const { data } = await sb
    .from("leads")
    .select(FORM_ROW_COLUMNS)
    .eq("caller_phone", phone)
    .eq("website_ladder", "calling")
    .order("created_at", { ascending: false })
    .limit(1)
  return ((data ?? [])[0] as FormRow | undefined) ?? null
}

export interface LadderSyncResult { state: LadderState; finished: boolean; enrolled: string | null }

/**
 * Recompute the ladder for one form row and write what follows from it:
 * the Follow Ups call reminder for the next attempt, or — when it's over —
 * website_ladder='done' (plus the website_followup drip when 3 calls went
 * unanswered). Idempotent; called by the call status callback, the recording
 * pipeline, and the 5-minute sweep.
 */
export async function syncLadder(sb: SupabaseClient, form: FormRow, now = new Date()): Promise<LadderSyncResult> {
  const rows = await clusterRows(sb, form)
  const state = computeLadder(form, rows, now)
  const isLadderReminder = (form.followup_reason || "").startsWith(LADDER_REASON_PREFIX)
  const stopped = !!form.is_dnc || !!form.is_junk || form.status === "dead"

  // The call analyzer stamps its own "try again in N days" reminder on every
  // voicemail call row; while the ladder runs (or hands off to the drip) the
  // ladder is the one schedule — one reminder per contact.
  if (state.phase === "calling" || state.phase === "unreached") {
    const callIds = rows.filter((r) => r.id !== form.id && r.lead_type === "call" && !r.twilio_number).map((r) => r.id)
    if (callIds.length) {
      const { error } = await sb
        .from("leads")
        .update({ recommended_followup_date: null, followup_reason: null })
        .in("id", callIds)
        .not("recommended_followup_date", "is", null)
      if (error) console.error(`[ladder] analyzer reminder clear failed for ${form.id}:`, error.message)
    }
  }

  if (state.phase === "calling" && !stopped) {
    const date = pacificDate(state.dueAt.getTime() < now.getTime() ? now : state.dueAt)
    const reason = ladderReason(state.attempt)
    if (form.recommended_followup_date !== date || form.followup_reason !== reason) {
      const { error } = await sb.from("leads").update({ recommended_followup_date: date, followup_reason: reason }).eq("id", form.id)
      if (error) console.error(`[ladder] reminder write failed for ${form.id}:`, error.message)
    }
    return { state, finished: false, enrolled: null }
  }
  if (state.phase === "connected" && !state.settled) return { state, finished: false, enrolled: null }

  const patch: Record<string, unknown> = { website_ladder: "done" }
  if (isLadderReminder) {
    patch.recommended_followup_date = null
    patch.followup_reason = null
  }
  let enrolled: string | null = null
  if (state.phase === "unreached" && !stopped) {
    enrolled = form.sms_consent && form.caller_phone ? WEBSITE_FOLLOWUP_SMS : form.email ? WEBSITE_FOLLOWUP_EMAIL : null
    if (enrolled) {
      patch.drip_campaign_type = enrolled
      patch.drip_touch_number = 0
      patch.last_drip_sent_at = now.toISOString()
    }
  }
  const { error } = await sb.from("leads").update(patch).eq("id", form.id).eq("website_ladder", "calling")
  if (error) {
    console.error(`[ladder] finish write failed for ${form.id}:`, error.message)
    return { state, finished: false, enrolled: null }
  }
  if (state.phase === "unreached" && !stopped) {
    const who = esc(form.name || form.caller_phone || "Website lead")
    await pingTelegram(
      enrolled
        ? `📵 ${who} — 3 calls, no answer. Moving to the website follow-up drip (${enrolled === WEBSITE_FOLLOWUP_SMS ? "texts" : "emails"}, 4 touches over 2 weeks — you approve each one).`
        : `📵 ${who} — 3 calls, no answer, and no way to message them (no text consent, no email). Nothing automatic follows.`,
      form.caller_phone
    )
  }
  return { state, finished: true, enrolled }
}

/**
 * After an outbound call ends without a conversation: the "just tried you"
 * message (text with consent, email otherwise), then the ladder resync. The
 * call row's call_conversation is already set by the caller. notify=false
 * (a failed dial — bad number) resyncs without messaging.
 */
export async function afterLadderCall(sb: SupabaseClient, phone: string, conversation: boolean, notify = true): Promise<void> {
  const form = await activeLadderForPhone(sb, phone)
  if (!form) return
  if (!conversation && notify) {
    if (form.sms_consent && form.caller_phone) {
      const out = await sendAutoText(sb, { phone: form.caller_phone, body: justTriedText(form.name), source: form.source })
      if (!out.ok && out.error !== "DNC") await sendTelegramAlert(`⚠️ "Just tried you" text to ${esc(form.name || phone)} failed — ${esc(out.error || "unknown")}`)
    } else if (form.email) {
      const m = justTriedEmail(form.name)
      const out = await sendAutoEmail(sb, { to: form.email, phone: form.caller_phone, name: form.name, address: form.property_address, subject: m.subject, body: m.body, source: form.source })
      if (!out.ok && out.error !== "DNC") await sendTelegramAlert(`⚠️ "Just tried you" email to ${esc(form.name || phone)} failed — ${esc(out.error || "unknown")}`)
    }
  }
  await syncLadder(sb, form)
}

/**
 * Outbound call of CONVERSATION_MIN_SEC or more on a laddered lead: the
 * status callback left call_conversation null, so the transcript decides —
 * Ryan leaving a long voicemail is not a conversation. Called from the
 * recording pipeline (lib/leads processRecordingBackground). No transcript →
 * counted as a conversation (no "just tried you" on a call that may have
 * connected).
 */
export async function classifyLadderCall(sb: SupabaseClient, callLeadId: string, transcript: string | null): Promise<void> {
  const { data: row } = await sb
    .from("leads")
    .select("caller_phone, call_conversation")
    .eq("id", callLeadId)
    .maybeSingle()
  if (!row?.caller_phone || row.call_conversation !== null) return
  const form = await activeLadderForPhone(sb, row.caller_phone)
  if (!form) return

  let conversation = true
  if (transcript && hasLlmKey()) {
    try {
      const out = await completeText({
        model: SONNET,
        maxTokens: 20,
        thinking: false,
        tag: "[ladder]",
        prompt: `Below is the transcript of an outbound phone call Ryan (a home buyer) placed to a seller lead. Did Ryan have a live, two-way conversation with a person, or did the call go to voicemail / an automated greeting (Ryan leaving a message counts as voicemail)?

Answer with exactly one word: CONVERSATION or VOICEMAIL.

TRANSCRIPT:
"${transcript.slice(0, 6000)}"`,
      })
      conversation = !/VOICEMAIL/i.test(out.text || "")
    } catch (e) {
      console.error("[ladder] classify call threw:", e instanceof Error ? e.message : String(e))
    }
  }
  const { error } = await sb.from("leads").update({ call_conversation: conversation }).eq("id", callLeadId)
  if (error) console.error(`[ladder] call_conversation write failed for ${callLeadId}:`, error.message)
  await afterLadderCall(sb, row.caller_phone, conversation)
}
