import { NextRequest, NextResponse } from "next/server"
import {
  detectOfferFromText,
  applyDetectedOfferToCluster,
  getLeadsClient,
  getTwilioNumber,
  registerManualTouch,
} from "@/lib/leads"

// Outbound message endpoint for the Leads + Follow Ups tabs. Sends via the
// Twilio Messaging API from the outbound caller-ID number (+16502043247) so
// leads see ONE number for both calls and texts, and logs the outbound
// message to the leads table with twilio_number=null (the outbound marker)
// so it shows up in the lead's event timeline.
//
// 2026-05-21 — migrated off the Mac-mini sidecar (iMessage w/ SMS fallback).
// The sidecar's SMS fallback sent from Ryan's personal Apple ID, so leads
// saw a different number than the one they texted. Twilio's A2P 10DLC
// campaign was approved (Messaging Service MG70a9310f… → VERIFIED) and
// +16502043247 attached to it, so app-initiated SMS is now compliant.
// Everything downstream of the send — DNC guard, the twilio_number=null
// outbound row, offer auto-detection, the new→contacted intake promotion —
// is unchanged from the sidecar version so the lead timeline threads
// exactly as before.
//
// Why a separate route instead of calling Twilio + PATCH /api/leads from the
// client: keeping the send + log atomic on the server avoids a half-state
// where the message went out but the row never got logged.

// Twilio requires strict E.164. DB caller_phone is already E.164 (it comes
// from Twilio webhooks), so this is defensive — but a malformed input would
// otherwise be rejected by Twilio with an opaque 21211.
function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith("+") && /^\+\d{10,15}$/.test(trimmed)) return trimmed
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}

export async function POST(request: NextRequest) {
  let body: { phone?: string; message?: string; source?: string | null } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const source = body.source ?? null

  if (!body.phone || typeof body.phone !== "string") {
    return NextResponse.json({ error: "phone is required" }, { status: 400 })
  }
  if (!body.message || typeof body.message !== "string" || !body.message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 })
  }
  const message = body.message
  const phone = normalizeE164(body.phone)
  if (!phone) {
    return NextResponse.json({ error: `Invalid phone: ${body.phone}` }, { status: 400 })
  }

  // DNC guard — never text a lead flagged Do-Not-Contact. Mirrors the
  // check in /api/leads/[id]/send-email. is_dnc is set on the cluster's
  // lead rows; if any row for this phone is flagged, block the send.
  // Fail-safe: if the check itself errors, block rather than risk a
  // contact (compliance > convenience — Ryan can retry).
  try {
    const sbDnc = getLeadsClient()
    const { data: dncRows, error: dncErr } = await sbDnc
      .from("leads")
      .select("id")
      .eq("caller_phone", phone)
      .eq("is_dnc", true)
      .limit(1)
    if (dncErr) {
      console.error("[leads/send] DNC check failed:", dncErr)
      return NextResponse.json({ error: "DNC check failed — send blocked" }, { status: 503 })
    }
    if (dncRows && dncRows.length > 0) {
      return NextResponse.json({ error: "lead is DNC" }, { status: 409 })
    }
  } catch (e) {
    console.error("[leads/send] DNC check threw:", e)
    return NextResponse.json({ error: "DNC check failed — send blocked" }, { status: 503 })
  }

  // Send via the Twilio Messaging API. fetch + Basic Auth (no twilio SDK) —
  // consistent with /api/leads/call and fetchTwilioAudio.
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

  // MessagingServiceSid routes through the approved A2P campaign explicitly
  // and is the carrier-preferred path; if it's not configured we send From
  // the number directly — that number is attached to the same approved
  // campaign, so it's equally compliant.
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim()
  const form = new URLSearchParams({ To: phone, Body: message })
  if (messagingServiceSid) {
    form.set("MessagingServiceSid", messagingServiceSid)
  } else {
    form.set("From", fromNumber)
  }

  let messageSid: string | null = null
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64")
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
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
      console.error("[leads/send] Twilio message create failed:", errMsg, json)
      return NextResponse.json({ success: false, error: errMsg }, { status: 502 })
    }
    messageSid = (json as { sid?: string })?.sid ?? null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[leads/send] Twilio fetch threw:", msg)
    return NextResponse.json(
      { success: false, error: "Twilio unavailable" },
      { status: 503 }
    )
  }

  // Send succeeded — log the outbound row. This is best-effort; if Supabase
  // fails the message still went out, so we still return success but flag
  // the logging failure.
  let loggedId: string | null = null
  let logError: string | null = null
  try {
    const sb = getLeadsClient()
    // twilio_number=null is the outbound marker — see lib/leads.ts conventions
    // (isOutbound() === !twilio_number). No separate is_outbound column needed.
    const { data, error } = await sb
      .from("leads")
      .insert({
        source,
        twilio_number: null,
        caller_phone: phone,
        lead_type: "sms",
        message,
        status: "contacted",
      })
      .select("id")
      .single()
    if (error) {
      logError = error.message
      console.error("[leads/send] Insert failed:", error)
    } else {
      loggedId = data?.id ?? null
    }

    // Auto-detect verbalized offer in this outbound SMS and stamp it on the
    // cluster. Same hands-off rule as the email path.
    if (loggedId) {
      try {
        const result = await detectOfferFromText(message, { channel: "sms" })
        if (result?.offer_verbalized && typeof result.offer_amount === "number") {
          const wrote = await applyDetectedOfferToCluster(sb, {
            leadId: loggedId,
            caller_phone: phone,
            email: null,
            offer_amount: result.offer_amount,
          })
          if (wrote) console.log(`[leads/send] auto-stamped offer $${result.offer_amount} on ${phone}`)
        }
      } catch (e) {
        console.warn(`[leads/send] offer detection failed:`, e instanceof Error ? e.message : String(e))
      }
    }

    // Phase 7C-may8 Bug 2: promote the original intake row (twilio_number
    // IS NOT NULL — that's the inbound side) from "new" → "contacted" so
    // the lead card's group status reflects that Ryan reached out, not
    // just the outbound event row's status.
    const { data: intake } = await sb
      .from("leads")
      .select("id, status")
      .eq("caller_phone", phone)
      .not("twilio_number", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
    const intakeRow = intake?.[0]
    if (intakeRow && intakeRow.status === "new") {
      const { error: promoteErr } = await sb
        .from("leads")
        .update({ status: "contacted" })
        .eq("id", intakeRow.id)
      if (promoteErr) console.error("[leads/send] Status promote failed:", promoteErr)
    }

    // Reset the drip cadence clock — a manual Send is a real touch. Without
    // this, last_drip_sent_at stays at its old value and the engine (or the
    // UI forecast) treats the next drip as immediately due even though Ryan
    // just sent a message. registerManualTouch also skips any live queue
    // rows so they don't double-fire alongside this manual message.
    if (loggedId) {
      try {
        await registerManualTouch(sb, { id: loggedId, caller_phone: phone, email: null })
      } catch (e) {
        console.warn("[leads/send] cadence reset failed:", e instanceof Error ? e.message : String(e))
      }
    }
  } catch (e) {
    logError = e instanceof Error ? e.message : String(e)
    console.error("[leads/send] Insert threw:", logError)
  }

  return NextResponse.json({
    success: true,
    service: "twilio_sms",
    messageSid,
    leadId: loggedId,
    logError,
  })
}
