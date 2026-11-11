import { getLeadsClient, getTwilioNumber, isOwnedNumber, CARD_LINE, FORWARD_TO } from "./leads"
import { PROD_BASE, relationshipCallerId } from "./relationship-calls"
import { getCardLineFlag } from "./card-line"
import { formatUsPhone } from "./office-inbound"

// Relationships click-to-call, as one function (2026-11-11). It lived inside
// POST /api/crms/call; "call him" on a Telegram alert needs the very same
// call (rings Ryan's cell, bridges the contact through the card line,
// recorded onto the card), so the core moved here and both callers use it.
// The route keeps its auth, body validation and response shape.
//
//   1. Insert the touch (call_status='dialing') so its id threads through
//      Twilio's callbacks.
//   2. Ask Twilio to ring Ryan's cell; when he answers, Twilio fetches
//      /api/crms/call/bridge, which dials the contact and records from answer.
// Card # ON (relationships.use_card_line): the contact sees the
// business-card line instead — bridge gets `line=card`, touch is stamped
// with twilio_number.

export function normalizeDialE164(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith("+") && /^\+\d{10,15}$/.test(trimmed)) return trimmed
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}

export interface OfficeCallResult {
  ok: boolean
  /** A human name (or the number) for the confirmation line. */
  label?: string
  error?: string
  /** HTTP status the card route answers with when !ok. */
  status?: number
  touchId?: string
  callSid?: string | null
  /** The number the contact sees. */
  callerId?: string
}

/** The number to dial: the one given, else the card's main number. Null when
 * neither is a dialable number. Pure. */
export function pickDialNumber(phone: string | null | undefined, cardPhone: string | null | undefined): string | null {
  if (phone && phone.trim()) return normalizeDialE164(phone)
  return cardPhone ? normalizeDialE164(cardPhone) : null
}

/** The bridge URL Twilio fetches when Ryan answers. `&` stays raw here — the
 * form body URL-encodes it; it is only ever put in TwiML via twimlAttr. */
export function bridgeUrlFor(touchId: string, to: string, cardLine: boolean): string {
  return (
    `${PROD_BASE}/api/crms/call/bridge` +
    `?touchId=${encodeURIComponent(touchId)}` +
    `&to=${encodeURIComponent(to)}` +
    (cardLine ? "&line=card" : "")
  )
}

export async function startOfficeRelayCall(args: {
  relationshipId: string
  /** The number to dial; the card's main phone when omitted. */
  phone?: string | null
  /** Stamped on the touch (the card UI sends the contact's tier/category). */
  tier?: string | null
  category?: string | null
}): Promise<OfficeCallResult> {
  const { relationshipId } = args
  if (!relationshipId) return { ok: false, error: "id and a valid phone are required", status: 400 }

  const sb = getLeadsClient()
  // The card: its name labels the confirmation, its main phone is the
  // fallback number. A failed read only matters when we have no number.
  let name: string | null = null
  let cardPhone: string | null = null
  let cardFound = false
  try {
    const { data } = await sb.from("relationships").select("name, phone").eq("id", relationshipId).maybeSingle<{ name: string | null; phone: string | null }>()
    if (data) { cardFound = true; name = data.name; cardPhone = data.phone }
  } catch (e) {
    console.error("[officeCall] card lookup failed:", e instanceof Error ? e.message : String(e))
  }

  const to = pickDialNumber(args.phone, cardPhone)
  if (!to) {
    if (!args.phone?.trim()) {
      return cardFound
        ? { ok: false, error: "no phone on this card — nothing to call", status: 400 }
        : { ok: false, error: "that Relationships card no longer exists", status: 404 }
    }
    return { ok: false, error: "id and a valid phone are required", status: 400 }
  }
  if (isOwnedNumber(to) || to === FORWARD_TO) {
    return { ok: false, error: `${to} is one of our own numbers — not dialing`, status: 400 }
  }
  try {
    const { checkContactDnc } = await import("./dnc")
    const dnc = await checkContactDnc(sb, { phone: to }, "call")
    if (dnc.dnc) return { ok: false, error: `Not calling — ${dnc.why}`, status: 409 }
  } catch (e) {
    return { ok: false, error: `DNC check failed — call blocked (${e instanceof Error ? e.message : String(e)})`, status: 503 }
  }

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return { ok: false, error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set", status: 500 }
  let fromNumber: string
  try {
    fromNumber = getTwilioNumber()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), status: 500 }
  }

  const label = name && name.trim() ? name.trim() : formatUsPhone(to)
  const cardLine = await getCardLineFlag(sb, relationshipId)
  const { data: touch, error: insErr } = await sb
    .from("relationship_touches")
    .insert({
      relationship_id: relationshipId,
      modality: "call",
      action: "call",
      call_status: "dialing",
      tier_at_touch: args.tier ?? null,
      category_at_touch: args.category ?? null,
      ...(cardLine ? { twilio_number: CARD_LINE } : {}),
    })
    .select("id")
    .single()
  if (insErr || !touch?.id) {
    console.error("[crms/call] touch insert failed:", insErr?.message)
    return { ok: false, error: insErr?.message || "touch insert failed", status: 500 }
  }
  const touchId = touch.id as string

  const auth = Buffer.from(`${sid}:${token}`).toString("base64")
  // StatusCallback covers the first leg: if Ryan's cell never picks up, the
  // bridge never runs and nothing else would ever stamp the touch.
  const form = new URLSearchParams({
    To: FORWARD_TO, From: fromNumber, Url: bridgeUrlFor(touchId, to, cardLine), Method: "POST",
    StatusCallback: `${PROD_BASE}/api/crms/call/status?touchId=${encodeURIComponent(touchId)}&leg=ryan`,
    StatusCallbackMethod: "POST",
    StatusCallbackEvent: "completed",
  })

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    })
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string }
    if (!res.ok) {
      console.error("[crms/call] Twilio call create failed:", json?.message, json)
      await sb.from("relationship_touches").delete().eq("id", touchId)
      return { ok: false, error: json?.message || `HTTP ${res.status}`, status: 502 }
    }
    await sb.from("relationship_touches").update({ call_sid: json.sid ?? null }).eq("id", touchId)
    return { ok: true, label, touchId, callSid: json.sid ?? null, callerId: cardLine ? CARD_LINE : relationshipCallerId() }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[crms/call] Twilio fetch threw:", msg)
    await sb.from("relationship_touches").delete().eq("id", touchId)
    return { ok: false, error: msg, status: 502 }
  }
}
