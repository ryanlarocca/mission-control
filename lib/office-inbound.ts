// Office-line inbound routing (brief: briefs/BRIEF_OFFICE_LINE_INBOUND_2026-09-24.md).
//
// The business card carries the Office — Ryan line. Callers there are
// mostly people Ryan met in person — agents, inspectors, vendors — not
// sellers, so an unknown caller becomes a Relationships contact, not a
// lead. Ryan (2026-09-24): "check first if they're in either category. If a
// lead calls, they stay a lead. If somebody is in Relationships already,
// their card gets updated. Otherwise default to Relationships."
//
// Check order: Relationships → Leads → create a Relationship.

import type { SupabaseClient } from "@supabase/supabase-js"
import { OFFICE_NUMBERS, isOwnedNumber, sendTelegramAlert } from "./leads"
import { normalizeAltPhones, relationshipsByAnyPhone, settleNewRelationship } from "./relationships"
import { queueInboundNote } from "./inboundFacts"

export type OfficeCaller =
  | { kind: "lead" }
  | {
      kind: "relationship"
      id: string
      name: string
      category: string | null
      tier: string | null
      isNew: boolean
      /** true when the stored name is still the phone-number placeholder */
      placeholderName: boolean
      /** Matched by the number signed in the text, not the sender: the
       * card's main number (E.164) — what replies go to. */
      signedAs?: string
    }

export const NEW_CONTACT_CATEGORY = "Agent"
export const NEW_CONTACT_TIER = "C"
export const NEW_CONTACT_SOURCE = "Business Card"

export function isOfficeLine(twilioNumber: string | null | undefined): boolean {
  return !!twilioNumber && OFFICE_NUMBERS.has(twilioNumber)
}

export function last10(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10)
}

export function toE164(phone: string): string | null {
  const d = last10(phone)
  return d.length === 10 ? `+1${d}` : null
}

// "(408) 555-1234" — the placeholder name for a contact we only know by number.
export function formatUsPhone(phone: string): string {
  const d = last10(phone)
  if (d.length !== 10) return phone
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

export function isPlaceholderName(name: string | null | undefined, phone: string): boolean {
  if (!name) return true
  const n = name.trim()
  return n === formatUsPhone(phone) || last10(n) === last10(phone)
}

function stampDay(): string {
  return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}

// US numbers written in a text ("Fernando | (408) 309-2868"), as 10 digits,
// minus the sender's own and ours. Order kept, de-duplicated.
export function signedPhones(body: string, sender: string): string[] {
  const own = last10(sender)
  const out: string[] = []
  for (const m of Array.from(body.matchAll(/(?<!\d)(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g))) {
    const d = `${m[1]}${m[2]}${m[3]}`
    if (d === own || out.includes(d) || isOwnedNumber(d)) continue
    out.push(d)
  }
  return out
}

// Resolve who's calling/texting an office line. Never throws — a lookup
// failure resolves to "lead" so the caller falls through to the intake
// path that already exists (we'd rather log a lead than drop a call).
// `body` (texts only): before a new card is made, a number signed in the
// message that's already on a card claims the sender — a wholesaler's
// blast comes from a bulk line but signs with his cell (2026-11-10, a
// known agent's Union Ave blast made a second card).
export async function resolveOfficeCaller(sb: SupabaseClient, phone: string, body?: string | null): Promise<OfficeCaller> {
  const norm = last10(phone)
  if (norm.length < 10) return { kind: "lead" }
  try {
    // 1. Relationships — their main number or one of their extras
    //    (alt_phones). Prefer an active row over do_not_contact.
    const rels = await relationshipsByAnyPhone<{ id: string; name: string | null; category: string | null; tier: string | null; status: string | null }>(
      sb, norm, "id, name, category, tier, status"
    )
    const rel = rels[0]
    if (rel?.id) {
      return {
        kind: "relationship",
        id: rel.id as string,
        name: (rel.name as string) || formatUsPhone(phone),
        category: (rel.category as string | null) ?? null,
        tier: (rel.tier as string | null) ?? null,
        isNew: false,
        placeholderName: isPlaceholderName(rel.name as string | null, phone),
      }
    }
    // 2. Leads — any prior inbound row for this number (same key the intake
    //    webhooks use for cluster inheritance).
    const { data: leads } = await sb
      .from("leads")
      .select("id")
      .eq("caller_phone", phone)
      .not("twilio_number", "is", null)
      .limit(1)
    if (leads && leads.length > 0) return { kind: "lead" }
    // 3. A number signed in the text that's on a card → that card.
    if (body) {
      const signed = await relationshipBySignedPhone(sb, phone, body)
      if (signed) return signed
    }
    // 4. Nobody — create the Relationships contact.
    return await createRelationshipForCaller(sb, phone)
  } catch (e) {
    console.error("[office-inbound] resolve failed, falling back to lead path:", e instanceof Error ? e.message : String(e))
    return { kind: "lead" }
  }
}

// Exactly one card must know the signed number (two = ambiguous, leave it).
// The sender's number is added to that card as an extra, so the next text
// from the bulk line lands there directly.
async function relationshipBySignedPhone(sb: SupabaseClient, phone: string, body: string): Promise<OfficeCaller | null> {
  const sender = toE164(phone)
  if (!sender) return null
  type Row = { id: string; name: string | null; phone: string | null; alt_phones: string[] | null; category: string | null; tier: string | null; notes: string | null; status: string | null }
  for (const d of signedPhones(body, phone).slice(0, 3)) {
    const rows = await relationshipsByAnyPhone<Row>(sb, d, "id, name, phone, alt_phones, category, tier, notes, status")
    if (rows.length !== 1) continue
    const r = rows[0]
    const line = `${formatUsPhone(phone)} added as an extra number ${stampDay()} — texted the office line signed with ${formatUsPhone(d)}.`
    const prev = (r.notes ?? "").trim()
    const { error } = await sb
      .from("relationships")
      .update({ alt_phones: normalizeAltPhones([...(r.alt_phones ?? []), sender], r.phone), notes: prev ? `${prev}\n\n${line}` : line })
      .eq("id", r.id)
    if (error) console.error("[office-inbound] signed-number alt phone add failed:", error.message)
    return {
      kind: "relationship",
      id: r.id,
      name: r.name || formatUsPhone(d),
      category: r.category ?? null,
      tier: r.tier ?? null,
      isNew: false,
      placeholderName: isPlaceholderName(r.name, d),
      signedAs: toE164(r.phone ?? d) ?? `+1${d}`,
    }
  }
  return null
}

async function createRelationshipForCaller(sb: SupabaseClient, phone: string): Promise<OfficeCaller> {
  const e164 = toE164(phone)
  if (!e164) return { kind: "lead" }
  const name = formatUsPhone(phone)
  const notes = `New contact — called the office line ${stampDay()}. Not previously in Leads or Relationships. Name/category are placeholders until the call transcript (or Ryan) fills them in.`
  const { data, error } = await sb
    .from("relationships")
    .insert({
      name,
      phone: e164,
      category: NEW_CONTACT_CATEGORY,
      tier: NEW_CONTACT_TIER,
      notes,
      source: NEW_CONTACT_SOURCE,
      status: "active",
      enriched_at: new Date().toISOString(),
    })
    .select("id")
    .single()
  if (error || !data?.id) {
    console.error("[office-inbound] relationships insert failed:", error?.message)
    return { kind: "lead" }
  }
  // A simultaneous webhook may have created this caller's card — use that one.
  const keepId = await settleNewRelationship(sb, data.id as string, e164)
  if (keepId !== data.id) return resolveOfficeCaller(sb, phone)
  return {
    kind: "relationship",
    id: data.id as string,
    name,
    category: NEW_CONTACT_CATEGORY,
    tier: NEW_CONTACT_TIER,
    isNew: true,
    placeholderName: true,
  }
}

// Open the touch row for an inbound call before the Dial goes out, so its
// id can thread through the Twilio callbacks (same pattern as click-to-call).
export async function openInboundCallTouch(
  sb: SupabaseClient,
  rel: Extract<OfficeCaller, { kind: "relationship" }>,
  callSid: string | null,
  line = "office line"
): Promise<string | null> {
  const { data, error } = await sb
    .from("relationship_touches")
    .insert({
      relationship_id: rel.id,
      modality: "call",
      action: "inbound",
      call_status: "ringing",
      call_sid: callSid,
      message: `📲 Inbound call to the ${line} — ringing`,
      tier_at_touch: rel.tier,
      category_at_touch: rel.category,
    })
    .select("id")
    .single()
  if (error || !data?.id) {
    console.error("[office-inbound] touch insert failed:", error?.message)
    return null
  }
  return data.id as string
}

// `twilioNumber` = the line the text came in on (E.164), so the card's
// Messages box can show it and a Telegram reply goes back out on it.
export async function logInboundTextTouch(
  sb: SupabaseClient,
  rel: Extract<OfficeCaller, { kind: "relationship" }>,
  body: string,
  twilioNumber?: string | null
): Promise<boolean> {
  const { error } = await sb.from("relationship_touches").insert({
    relationship_id: rel.id,
    modality: "sms",
    action: "inbound",
    message: body,
    tier_at_touch: rel.tier,
    category_at_touch: rel.category,
    ...(twilioNumber ? { twilio_number: twilioNumber } : {}),
  })
  if (error) console.error("[office-inbound] text touch insert failed:", error.message)
  else queueInboundNote(rel.id, "text", body)
  return !error
}

export function describeContact(rel: Extract<OfficeCaller, { kind: "relationship" }>): string {
  const who = `<b>${rel.name}</b>${rel.category && !rel.isNew ? ` (${rel.category})` : ""}`
  return rel.isNew ? `${who} — new contact, added to Relationships` : who
}

// ── Missed call, no voicemail (2026-11-11) ─────────────────────────────────
// Ryan: "if somebody calls … the business line, I want the Telegram alert."
// A contact who rang, got nobody and left nothing used to produce only the
// "📲 Office line call" ring alert and then silence. The moments we can know
// "nobody answered and nothing was left" from callbacks that already exist:
//   1. /api/crms/call/inbound (<Dial action>) — the caller hung up while it
//      was ringing: DialCallStatus "canceled" (or the parent call already
//      "completed"). The voicemail TwiML we return is ignored; no recording
//      callback will ever come.
//   2. /api/crms/call/recording?voicemail=1 (<Record action>) — the caller
//      reached the beep but left nothing: no RecordingUrl, or a recording
//      under the transcribe floor (a hang-up, a breath).
//   3. A caller who hangs up during the 23 s greeting, before <Record>
//      starts, triggers no callback at all — Twilio sends nothing. So the
//      <Dial action> handler looks again GREETING_CHECK_MS later: if Twilio
//      says the call is over and no recording ever arrived, that was a
//      hang-up in the greeting (app/api/crms/call/inbound).
// Each alert goes out at most once: the alerting callback first CLAIMS the
// touch by moving call_status to "missed" (conditional UPDATE), so a Twilio
// retry — or the other callback — finds it taken and stays quiet.

export const MISSED_CALL_STATUS = "missed"
// When the <Dial action> handler re-checks a call it sent to voicemail: the
// greeting is 23 s, so by now the caller is either recording or gone.
export const GREETING_CHECK_MS = 40_000
// Then this long for a <Record action> that fired at the same moment to
// reach the recording route and put its recording_url on the touch.
export const RECORD_SETTLE_MS = 5_000

/** Twilio call statuses that mean the caller is still on the line. */
const LIVE_CALL_STATUSES = new Set(["queued", "initiated", "ringing", "in-progress"])
/** The call has ended, per Twilio's REST status. Unknown / empty = can't tell, so not over. */
export function callIsOver(status: string | null | undefined): boolean {
  return !!status && !LIVE_CALL_STATUSES.has(status)
}
/** call_status values a touch can be in when a missed-call alert may fire:
 * "ringing" (opened by openInboundCallTouch) and "voicemail" (stamped by the
 * <Dial action> once the greeting is offered). "completed" (answered) and
 * "missed" (already alerted) never are. */
export const MISSED_CLAIMABLE_STATUSES = ["ringing", "voicemail"] as const

/** The <Dial action> says the caller is gone, so no voicemail can follow:
 * "canceled" is Twilio's word for the parent hanging up while the dialed leg
 * was still ringing; a parent CallStatus of "completed" on a non-answered
 * dial says the same thing. An answered dial is never this. */
export function callerHungUpWhileRinging(dialStatus: string, parentCallStatus: string): boolean {
  if (dialStatus === "completed") return false
  return dialStatus === "canceled" || parentCallStatus === "completed"
}

/** A voicemail <Record action> that carries nothing worth transcribing: no
 * recording URL at all, or a recording shorter than `floorSec`. Unknown
 * duration with a URL is NOT empty — the pipeline will transcribe it. */
export function isEmptyVoicemail(args: { hasRecording: boolean; durationSec: number | null; floorSec: number }): boolean {
  if (!args.hasRecording) return true
  return args.durationSec !== null && args.durationSec < args.floorSec
}

export type MissedClaimState = "claimable" | "already" | "ineligible"

/** Where a touch stands for the missed-call alert, from its call_status. */
export function missedClaimState(callStatus: string | null | undefined): MissedClaimState {
  if (callStatus === MISSED_CALL_STATUS) return "already"
  return (MISSED_CLAIMABLE_STATUSES as readonly string[]).includes(callStatus ?? "") ? "claimable" : "ineligible"
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** The alert text. A caller we only know by number (placeholder name, the
 * default category) is "New contact" rather than their number twice. */
export function missedCallAlertText(args: { name: string | null; category: string | null; number: string | null; placeholderName: boolean }): string {
  const who = args.placeholderName || !args.name
    ? "<b>New contact</b>"
    : `<b>${escHtml(args.name)}</b>${args.category ? ` (${escHtml(args.category)})` : ""}`
  const num = args.number ? formatUsPhone(args.number) : "number unknown"
  return `📵 <b>Missed call</b> — office line — ${who} — ${num}\nNo voicemail.`
}

export type MissedCallOutcome = "alerted" | "already" | "ineligible"

/** Send the "Missed call … No voicemail." alert for an inbound office-line
 * touch, once. "alerted" = this call sent it; "already" = an earlier callback
 * did (a retry); "ineligible" = the touch isn't a missed call (answered, no
 * such row, a DB error) — the caller keeps whatever it did before. */
export async function alertMissedOfficeCall(
  sb: SupabaseClient,
  touchId: string,
  // `noRecording`: claim only while no recording has reached the touch — the
  // greeting re-check must never beat a real voicemail that just landed.
  opts: { callerPhone?: string | null; noRecording?: boolean; patch?: { message?: string; call_duration_sec?: number | null } } = {}
): Promise<MissedCallOutcome> {
  let claim = sb
    .from("relationship_touches")
    .update({ call_status: MISSED_CALL_STATUS, ...(opts.patch ?? {}) })
    .eq("id", touchId)
    .eq("action", "inbound")
    .in("call_status", [...MISSED_CLAIMABLE_STATUSES])
    .is("transcript", null)
  if (opts.noRecording) claim = claim.is("recording_url", null)
  const { data: claimed, error } = await claim.select("relationship_id")
  if (error) {
    console.error("[office-inbound] missed-call claim failed:", error.message)
    return "ineligible"
  }
  const relationshipId = (claimed?.[0]?.relationship_id as string | undefined) ?? null
  if (!relationshipId) {
    const { data: cur } = await sb.from("relationship_touches").select("call_status").eq("id", touchId).maybeSingle<{ call_status: string | null }>()
    return missedClaimState(cur?.call_status) === "already" ? "already" : "ineligible"
  }

  let name: string | null = null
  let category: string | null = null
  let cardPhone: string | null = null
  try {
    const { data: rel } = await sb.from("relationships").select("name, category, phone").eq("id", relationshipId).maybeSingle<{ name: string | null; category: string | null; phone: string | null }>()
    if (rel) { name = rel.name; category = rel.category; cardPhone = rel.phone }
  } catch (e) {
    console.error("[office-inbound] missed-call card lookup failed:", e instanceof Error ? e.message : String(e))
  }
  // Their number: the one they called from (a card can answer to several),
  // else the card's main number.
  const caller = opts.callerPhone ? toE164(opts.callerPhone) : null
  const number = caller ?? cardPhone
  const ok = await sendTelegramAlert(
    missedCallAlertText({ name, category, number, placeholderName: !!number && isPlaceholderName(name, number) }),
    { about: { kind: "relationship", relationshipId, phone: number, line: "office" } }
  )
  if (!ok) console.error(`[office-inbound] missed-call alert for touch ${touchId} was not delivered`)
  return "alerted"
}
