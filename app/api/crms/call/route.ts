import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, getTwilioNumber, isOwnedNumber, FORWARD_TO } from "@/lib/leads"
import { PROD_BASE, relationshipCallerId } from "@/lib/relationship-calls"

// Relationships-tab click-to-call. Mirrors /api/leads/call but the record is a
// `relationship_touches` row (modality='call') instead of a lead:
//   1. Insert the touch (call_status='dialing') so its id can thread through
//      Twilio's callbacks.
//   2. Ask Twilio to ring Ryan's cell from one of our lines; when he answers,
//      Twilio fetches /api/crms/call/bridge, which dials the contact showing
//      Ryan's own cell (a Twilio Verified Caller ID) and records from answer.
// GET ?touchId= lets the card poll the outcome while the call is in flight.

function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith("+") && /^\+\d{10,15}$/.test(trimmed)) return trimmed
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}

export async function POST(request: NextRequest) {
  let body: { id?: string; phone?: string; tier?: string; category?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const relationshipId = body.id
  const to = body.phone ? normalizeE164(body.phone) : null
  if (!relationshipId || !to) {
    return NextResponse.json({ error: "id and a valid phone are required" }, { status: 400 })
  }
  if (isOwnedNumber(to) || to === FORWARD_TO) {
    return NextResponse.json({ error: `${to} is one of our own numbers — not dialing` }, { status: 400 })
  }

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) {
    return NextResponse.json({ error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set" }, { status: 500 })
  }
  let fromNumber: string
  try {
    fromNumber = getTwilioNumber()
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }

  const sb = getLeadsClient()
  const { data: touch, error: insErr } = await sb
    .from("relationship_touches")
    .insert({
      relationship_id: relationshipId,
      modality: "call",
      action: "call",
      call_status: "dialing",
      tier_at_touch: body.tier ?? null,
      category_at_touch: body.category ?? null,
    })
    .select("id")
    .single()
  if (insErr || !touch?.id) {
    console.error("[crms/call] touch insert failed:", insErr?.message)
    return NextResponse.json({ error: insErr?.message || "touch insert failed" }, { status: 500 })
  }
  const touchId = touch.id as string

  const bridgeUrl =
    `${PROD_BASE}/api/crms/call/bridge` +
    `?touchId=${encodeURIComponent(touchId)}` +
    `&to=${encodeURIComponent(to)}`

  const auth = Buffer.from(`${sid}:${token}`).toString("base64")
  // StatusCallback covers the first leg: if Ryan's cell never picks up, the
  // bridge never runs and nothing else would ever stamp the touch.
  const form = new URLSearchParams({
    To: FORWARD_TO, From: fromNumber, Url: bridgeUrl, Method: "POST",
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
      return NextResponse.json({ error: json?.message || `HTTP ${res.status}` }, { status: 502 })
    }
    await sb.from("relationship_touches").update({ call_sid: json.sid ?? null }).eq("id", touchId)
    return NextResponse.json({ success: true, touchId, callSid: json.sid ?? null, callerId: relationshipCallerId() })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[crms/call] Twilio fetch threw:", msg)
    await sb.from("relationship_touches").delete().eq("id", touchId)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}

export async function GET(request: NextRequest) {
  const touchId = request.nextUrl.searchParams.get("touchId")
  if (!touchId) return NextResponse.json({ error: "touchId required" }, { status: 400 })
  const { data, error } = await getLeadsClient()
    .from("relationship_touches")
    .select("call_status, call_duration_sec, message, recording_url, transcript")
    .eq("id", touchId)
    .single()
  if (error || !data) return NextResponse.json({ error: error?.message || "not found" }, { status: 404 })
  return NextResponse.json({
    status: data.call_status,
    durationSec: data.call_duration_sec,
    summary: data.transcript ? data.message : null,
    outcome: !data.transcript ? data.message : null,
    hasRecording: !!data.recording_url,
  })
}
