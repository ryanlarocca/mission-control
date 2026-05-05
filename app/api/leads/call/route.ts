import { NextRequest, NextResponse } from "next/server"
import { FORWARD_TO, getLeadsClient, getTwilioNumber } from "@/lib/leads"

// Outbound call relay. Click "Call" on a lead card →
//   1. Insert an outbound `lead_type=call` row (twilio_number=null per the
//      outbound convention; status="contacted") so the timeline shows it
//      immediately.
//   2. POST to Twilio's REST API to dial Ryan's cell with the
//      `TWILIO_NUMBER` env (see lib/leads.ts getTwilioNumber()) as the
//      from-number.
//   3. When Ryan answers, Twilio fetches the bridge URL (TwiML) which
//      `<Dial>`s the lead's number with record-from-answer. Recording is
//      delivered back to /api/leads/call/recording?leadId=… which attaches
//      it to the row inserted in step 1.
//
// Bridge URL has to be publicly reachable — it's hardcoded to the prod
// alias same as the inbound voice routes do (RECORDING_CALLBACK_URL).
//
// We use fetch + Basic Auth for the Twilio REST call instead of pulling in
// the twilio SDK (consistent with how `fetchTwilioAudio` already works).

const PROD_BASE = "https://mission-control-three-chi.vercel.app"

function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith("+") && /^\+\d{10,15}$/.test(trimmed)) return trimmed
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}

export async function POST(request: NextRequest) {
  let body: { phone?: string; source?: string | null } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const phoneInput = body.phone
  if (!phoneInput || typeof phoneInput !== "string") {
    return NextResponse.json({ error: "phone is required" }, { status: 400 })
  }
  const leadPhone = normalizeE164(phoneInput)
  if (!leadPhone) {
    return NextResponse.json({ error: `Invalid phone: ${phoneInput}` }, { status: 400 })
  }

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) {
    return NextResponse.json(
      { error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set" },
      { status: 500 }
    )
  }
  let fromNumber: string
  try {
    fromNumber = getTwilioNumber()
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }

  // Insert the outbound call row first so we have a leadId to thread
  // through to the recording callback. twilio_number=null (outbound marker
  // per lib/leads.ts conventions); source is inherited from the group if
  // the UI passed it.
  let leadId: string | null = null
  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("leads")
      .insert({
        source: body.source ?? null,
        twilio_number: null,
        caller_phone: leadPhone,
        lead_type: "call",
        status: "contacted",
      })
      .select("id")
      .single()
    if (error) {
      console.error("[leads/call] Insert failed:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    leadId = data?.id ?? null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[leads/call] Insert threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  if (!leadId) {
    return NextResponse.json({ error: "Failed to create lead row" }, { status: 500 })
  }

  const bridgeUrl =
    `${PROD_BASE}/api/leads/call/bridge` +
    `?leadPhone=${encodeURIComponent(leadPhone)}` +
    `&leadId=${encodeURIComponent(leadId)}`

  const auth = Buffer.from(`${sid}:${token}`).toString("base64")
  const form = new URLSearchParams({
    To: FORWARD_TO,
    From: fromNumber,
    Url: bridgeUrl,
    Method: "POST",
  })

  let callSid: string | null = null
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      const errMsg = (json as { message?: string })?.message || `HTTP ${res.status}`
      console.error("[leads/call] Twilio call create failed:", errMsg, json)
      // Roll back the row so we don't leave a dangling outbound entry.
      try {
        const sb = getLeadsClient()
        await sb.from("leads").delete().eq("id", leadId)
      } catch (e) {
        console.error("[leads/call] Rollback delete threw:", e)
      }
      return NextResponse.json({ error: errMsg }, { status: 502 })
    }
    callSid = (json as { sid?: string })?.sid ?? null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[leads/call] Twilio fetch threw:", msg)
    try {
      const sb = getLeadsClient()
      await sb.from("leads").delete().eq("id", leadId)
    } catch (rollbackErr) {
      console.error("[leads/call] Rollback delete threw:", rollbackErr)
    }
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  return NextResponse.json({ success: true, callSid, leadId })
}
