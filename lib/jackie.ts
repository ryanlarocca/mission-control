// Jackie (AI receptionist) — how a live Twilio call reaches her.
//
// Until 10-27 the test line sat on an Elastic SIP trunk wired straight to
// OpenAI, so Jackie answered before anything else could happen. The mailer
// lines need Ryan's cell to ring first, so Jackie is reached mid-call
// instead: the no-answer step returns <Dial><Sip> to OpenAI's SIP address.
// OpenAI then POSTs live.transport.incoming to /api/voice-test/incoming,
// which reads the x-lrg-* headers below to know which line and lead the
// call belongs to. Twilio records the leg and enforces the 11-minute cap.
//
// sip_headers are caller-supplied metadata as far as OpenAI is concerned
// (anyone who knows the project's SIP address can put anything there), so
// they only label a call — they never unlock coach mode or anything else.

import type { SupabaseClient } from "@supabase/supabase-js"
import { twimlAttr } from "@/lib/relationship-calls"
import { relationshipsByAnyPhone } from "@/lib/relationships"
import { completeText, extractJsonObject, SONNET } from "@/lib/llm"

const OPENAI_SIP_PROJECT = "proj_cdGIRfYygFHgxVOhoeq1nUJe"

// Hard cap on Twilio's side (Ryan, 10-25: 11 minutes). The sideband watcher
// wraps her at 10 min and hangs up at 11; this catches the case where the
// watcher itself died.
export const JACKIE_TIME_LIMIT_SEC = 11 * 60 + 15

export type JackieCallTags = {
  /** Which line the caller dialed — "test" or a CAMPAIGN_MAP label. */
  line: string
  /** Lead row the call belongs to (production lines). */
  leadId?: string | null
}

export function jackieSipUri(tags: JackieCallTags): string {
  const headers = new URLSearchParams({ "x-lrg-line": tags.line })
  if (tags.leadId) headers.set("x-lrg-lead", tags.leadId)
  // secure=true = SRTP. TLS alone only encrypts signaling, and OpenAI
  // answers plain RTP with 488 Not Acceptable Here (measured 10-27).
  return `sip:${OPENAI_SIP_PROJECT}@sip.api.openai.com;transport=tls;secure=true?${headers.toString()}`
}

/**
 * TwiML that hands the live call to Jackie. `action` gets Twilio's
 * DialCallStatus when her leg ends (or fails to connect — that's where the
 * voicemail fallback lives); `recordingCallback`, if given, receives the
 * dual-channel recording of her conversation.
 */
export function jackieDialTwiml(opts: {
  tags: JackieCallTags
  action: string
  recordingCallback?: string
}): string {
  const record = opts.recordingCallback
    ? ` record="record-from-answer-dual" recordingStatusCallback="${twimlAttr(opts.recordingCallback)}" recordingStatusCallbackMethod="POST"`
    : ` record="record-from-answer-dual"`
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="15" timeLimit="${JACKIE_TIME_LIMIT_SEC}" action="${twimlAttr(opts.action)}" method="POST"${record}>
    <Sip>${twimlAttr(jackieSipUri(opts.tags))}</Sip>
  </Dial>
</Response>`
}

/** The x-lrg-* labels (and Twilio's own call sid) from OpenAI's sip_headers. */
export function jackieTagsFromSipHeaders(sipHeaders: unknown): {
  line: string | null
  leadId: string | null
  twilioCallSid: string | null
} {
  const get = (name: string): string | null => {
    if (!Array.isArray(sipHeaders)) return null
    const h = sipHeaders.find((x) => typeof x?.name === "string" && x.name.toLowerCase() === name)
    return typeof h?.value === "string" && h.value.trim() ? h.value.trim() : null
  }
  const leadId = get("x-lrg-lead")
  return {
    line: get("x-lrg-line"),
    leadId: leadId && /^[0-9a-f-]{36}$/i.test(leadId) ? leadId : null,
    twilioCallSid: get("x-twilio-callsid"),
  }
}

// ─── Who Jackie answers (mailer lines, Ryan 2026-11-03) ────────────────────
//
// Ryan's cell rings 12 s first, exactly as before. When he doesn't pick up
// on a JACKIE_LINES number (lib/leads.ts) and the switch is on, Jackie takes
// the call — no coin flip since 11-03 (the 10-27 → 11-03 flip rows keep
// their arms). A caller who's been in touch before gets her returning-caller
// note (name + property from the card) instead of the full intake. Still
// voicemail: anyone with a Relationships card, anyone who asked off the list
// (DNC), a number only in Ryan's iPhone history (no card to say who they
// are), and a number Jackie already took 3 calls from today. Withheld
// numbers share a cap of 3 Jackie calls a day.
//
// call_arm on the intake row: "jackie" = first-time caller she took,
// "returning" = known number (whoever handled it; jackie_call says if she
// did), "answered" = Ryan picked up a first-time caller.

export const JACKIE_FLIP_KEY = "jackie_flip"
export const ANONYMOUS_JACKIE_PER_DAY = 3
export const JACKIE_PER_NUMBER_PER_DAY = 3

export type CallArm = "answered" | "voicemail" | "jackie" | "returning"

export type JackieFlipSettings = {
  on: boolean
  changed_at?: string
  /** Numbers that always reach Jackie (Ryan's own tests); never scored. */
  force_numbers?: string[]
}

export async function getJackieFlip(sb: SupabaseClient): Promise<JackieFlipSettings> {
  const { data, error } = await sb.from("inbox_settings").select("value").eq("key", JACKIE_FLIP_KEY).maybeSingle()
  if (error) throw new Error(`jackie_flip read failed: ${error.message}`)
  const v = (data?.value ?? {}) as Partial<JackieFlipSettings>
  return {
    on: v.on === true,
    changed_at: typeof v.changed_at === "string" ? v.changed_at : undefined,
    force_numbers: Array.isArray(v.force_numbers) ? v.force_numbers.filter((n): n is string => typeof n === "string") : [],
  }
}

export async function setJackieFlip(sb: SupabaseClient, on: boolean): Promise<JackieFlipSettings> {
  const current = await getJackieFlip(sb)
  const next = { ...current, on, changed_at: new Date().toISOString() }
  const { error } = await sb.from("inbox_settings").upsert({ key: JACKIE_FLIP_KEY, value: next, updated_at: next.changed_at })
  if (error) throw new Error(`jackie_flip write failed: ${error.message}`)
  return next
}

export type ArmDecision = {
  /** Scored arm; null = not scored (forced test number, withheld-number cap). */
  arm: CallArm | null
  /** Send this caller to Jackie (otherwise voicemail, or nothing if answered). */
  jackie: boolean
  reason: string
}

export type CallerHistory = {
  /** Most recent name / property on this number's lead rows; null = no prior lead row. */
  prior: { name: string | null; property_address: string | null } | null
  relationship: boolean
  /** In Ryan's iPhone call log. */
  iphone: boolean
  dnc: boolean
}

export const NO_HISTORY: CallerHistory = { prior: null, relationship: false, iphone: false, dnc: false }

/** Pure: where a call goes. */
export function decideArm(input: {
  answered: boolean
  anonymous: boolean
  anonymousJackieToday: number
  /** Jackie calls already taken from this number today. */
  jackieToday: number
  forced: boolean
  history: CallerHistory
}): ArmDecision {
  if (input.forced) return { arm: null, jackie: !input.answered, reason: "test number" }
  const h = input.anonymous ? NO_HISTORY : input.history
  const known = !!h.prior || h.relationship || h.iphone
  const arm: CallArm = known ? "returning" : input.answered ? "answered" : "jackie"
  if (input.answered) return { arm, jackie: false, reason: "Ryan answered" }
  if (h.relationship) return { arm, jackie: false, reason: "Relationships contact" }
  if (h.dnc) return { arm, jackie: false, reason: "asked to come off the list" }
  if (!h.prior && h.iphone) return { arm, jackie: false, reason: "in Ryan's iPhone history, no lead card" }
  if (input.anonymous && input.anonymousJackieToday >= ANONYMOUS_JACKIE_PER_DAY) {
    return { arm: null, jackie: false, reason: "withheld-number Jackie cap reached today" }
  }
  if (!input.anonymous && input.jackieToday >= JACKIE_PER_NUMBER_PER_DAY) {
    return { arm, jackie: false, reason: `Jackie already took ${JACKIE_PER_NUMBER_PER_DAY} calls from this number today` }
  }
  return { arm, jackie: true, reason: known ? "returning caller" : "first-time caller" }
}

/**
 * What we know about this number: its other lead rows (name, property,
 * DNC), a Relationships card, Ryan's iPhone history. Throws on a read error
 * — the caller sends that call to voicemail.
 */
export async function callerHistory(sb: SupabaseClient, phone: string, currentLeadId: string | null): Promise<CallerHistory> {
  let q = sb.from("leads").select("name, property_address, is_dnc").eq("caller_phone", phone).order("created_at", { ascending: false }).limit(50)
  if (currentLeadId) q = q.neq("id", currentLeadId)
  const [leads, rels, calls] = await Promise.all([
    q,
    relationshipsByAnyPhone(sb, phone.replace(/\D/g, "").slice(-10), "id", 1),
    sb.from("phone_calls").select("id").eq("phone", phone).limit(1),
  ])
  if (leads.error) throw new Error(`caller history leads read: ${leads.error.message}`)
  if (calls.error) throw new Error(`caller history phone_calls read: ${calls.error.message}`)
  const rows = (leads.data ?? []) as { name: string | null; property_address: string | null; is_dnc: boolean | null }[]
  const firstOf = (k: "name" | "property_address") => rows.map((r) => r[k]?.trim()).find((v): v is string => !!v) ?? null
  return {
    prior: rows.length ? { name: firstOf("name"), property_address: firstOf("property_address") } : null,
    relationship: rels.length > 0,
    iphone: (calls.data?.length ?? 0) > 0,
    dnc: rows.some((r) => r.is_dnc === true),
  }
}

function pacificMidnightIso(): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date())
  // Pacific midnight as an instant: the offset is -7 or -8; take the earlier
  // bound (−8) so a DST day never undercounts.
  return new Date(`${ymd}T00:00:00-08:00`).toISOString()
}

/** Jackie calls to withheld numbers since Pacific midnight. */
export async function anonymousJackieCallsToday(sb: SupabaseClient): Promise<number> {
  const { count, error } = await sb
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("call_arm", "jackie")
    .eq("jackie_call->>anonymous", "true")
    .gte("created_at", pacificMidnightIso())
  if (error) throw new Error(`anonymous Jackie count: ${error.message}`)
  return count ?? 0
}

/** Jackie calls from this number since Pacific midnight. */
export async function jackieCallsTodayFrom(sb: SupabaseClient, phone: string): Promise<number> {
  const { count, error } = await sb
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("caller_phone", phone)
    .not("jackie_call", "is", null)
    .gte("created_at", pacificMidnightIso())
  if (error) throw new Error(`Jackie per-number count: ${error.message}`)
  return count ?? 0
}

/** "140 Johnson Ave, Los Gatos, CA 95030" → "140 Johnson Ave, Los Gatos" (how a person says it). */
export function spokenAddress(addr: string): string {
  return addr.replace(/,?\s*(CA|California)\b.*$/i, "").replace(/,?\s*\b\d{5}(-\d{4})?\s*$/, "").trim()
}

/**
 * Appended to Jackie's instructions for a returning caller: what the card
 * says, and the short version of her job. Name and property are from our
 * own records, never from the caller's SIP headers.
 */
export function returningCallerNote(prior: { name?: string | null; property_address?: string | null }): string {
  const name = prior.name?.trim() || null
  const addr = prior.property_address?.trim() ? spokenAddress(prior.property_address.trim()) : null
  const onFile = [
    name ? `name ${name}` : "no name on file",
    addr ? `property ${addr}` : "no property address on file",
  ].join(", ")
  return `\n\nRETURNING CALLER
This number has been in touch with Ryan before. On file: ${onFile}.
- Someone else could be calling from this phone, so don't greet them by name or assume who it is. Once they tell you their name, use it.
- ${addr
    ? "Check the property with a quick question in your own words (whether this is about the house on that street). If they say yes, you have the address; don't ask for it again. If it's a different property, get that address."
    : "Getting the property address is still your top priority."}
- Skip the rest of the intake (no questions about why they're selling, the condition, and so on) unless they bring it up. Ask what they'd like Ryan to know, when's a good time for him to call, and check the callback number.
- If they say Ryan called them or they're calling him back, tell them he's tied up right now and you'll let him know they called back.`
}

// ─── After her call ──────────────────────────────────────────────────────────

export type JackieCallReview = {
  intake_complete: boolean
  callback_when: string | null
  callback_date: string | null
  spanish: boolean
  /** The caller asked to come off the list (2026-11-03). */
  opted_out?: boolean
  opt_out_address?: string | null
}

function pacificToday(now: Date): { ymd: string; weekday: string; clock: string } {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now)
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long" }).format(now)
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).format(now)
  return { ymd, weekday, clock }
}

/** Next weekday after `ymd` (Jackie's default promise: one business day). */
export function nextBusinessDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`)
  do d.setUTCDate(d.getUTCDate() + 1)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
  return d.toISOString().slice(0, 10)
}

/**
 * Reads the transcript of a Jackie call: did she get the intake (name,
 * address, callback time), and what callback did she promise? Null on any
 * model failure — the card still gets the normal call analysis.
 */
export async function reviewJackieCall(transcript: string, now: Date = new Date()): Promise<JackieCallReview | null> {
  const { ymd, weekday, clock } = pacificToday(now)
  const prompt = `This is a phone call between Jackie, the AI receptionist for LRG Homes (Ryan, a Bay Area home buyer), and someone who called one of his mailer lines (usually about a letter he mailed, sometimes calling back someone Ryan already spoke with). The transcript has no speaker labels.

It is now ${weekday} ${ymd}, ${clock} Pacific.

Answer in JSON only:
{
  "intake_complete": true if the caller gave a name (or confirmed one Jackie had on file), a property address (street number + street, a city if they said it; a property Jackie already had on file and the caller confirmed counts), and either a callback time or agreed Ryan can call them; false otherwise (hung up early, refused, wrong number, wanted off the list),
  "callback_when": the callback Jackie promised or the caller asked for, in a few words as said ("tomorrow around noon", "next Thursday after 3", "within one business day"), or null if none,
  "callback_date": that callback as YYYY-MM-DD in Pacific time, or null if no callback was arranged,
  "spanish": true if the caller spoke Spanish,
  "opted_out": true ONLY if the CALLER explicitly asked to be removed or not contacted again ("take me off your list", "stop sending me letters", "don't call me again", or said yes when Jackie offered to take them off the list). Jackie offering is not enough, and "not interested" / "not selling" alone is false,
  "opt_out_address": the property address the caller wanted taken off the list, as said, or null
}

Transcript:
${transcript.slice(0, 20000)}`
  try {
    const out = await completeText({ prompt, model: SONNET, maxTokens: 500, thinking: false, tag: "[jackie-review]" })
    const j = JSON.parse(extractJsonObject(out.text)) as Partial<JackieCallReview>
    const date = typeof j.callback_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(j.callback_date) && j.callback_date >= ymd ? j.callback_date : null
    return {
      intake_complete: j.intake_complete === true,
      callback_when: typeof j.callback_when === "string" && j.callback_when.trim() ? j.callback_when.trim().slice(0, 120) : null,
      callback_date: date,
      spanish: j.spanish === true,
      opted_out: j.opted_out === true,
      opt_out_address: typeof j.opt_out_address === "string" && j.opt_out_address.trim() ? j.opt_out_address.trim().slice(0, 160) : null,
    }
  } catch (e) {
    console.error(`[jackie-review] failed: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

/** Marks the transcript so drafts and the card know nobody left a voicemail. */
export const JACKIE_TRANSCRIPT_PREFIX = "[Call answered by Jackie, Ryan's AI receptionist. Not a voicemail.]\n"

/** Shallow-merge into leads.jackie_call (read-modify-write; one writer per phase). */
export async function mergeJackieCall(sb: SupabaseClient, leadId: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await sb.from("leads").select("jackie_call").eq("id", leadId).maybeSingle()
  if (error) throw new Error(`jackie_call read: ${error.message}`)
  const current = (data?.jackie_call ?? {}) as Record<string, unknown>
  const { error: upd } = await sb.from("leads").update({ jackie_call: { ...current, ...patch } }).eq("id", leadId)
  if (upd) throw new Error(`jackie_call write: ${upd.message}`)
}

// Ryan's voicemail greeting + record — the mailer lines' no-answer TwiML,
// shared so a Jackie leg that fails to connect lands in the same voicemail.
const GREETING_URL = "https://mission-control-three-chi.vercel.app/voicemail-greeting.mp3"
const VOICEMAIL_RECORDING_URL = "https://mission-control-three-chi.vercel.app/api/leads/voice/recording"
export function leadVoicemailTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${GREETING_URL}</Play>
  <Record maxLength="120" timeout="5" transcribe="false"
    action="${VOICEMAIL_RECORDING_URL}"
    method="POST" />
  <Say voice="alice">Thank you. Goodbye.</Say>
</Response>`
}
