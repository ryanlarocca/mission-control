import { NextResponse } from "next/server"
import {
  getCampaignSource,
  getLeadsClient,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"

// Called as the <Record action="..."> target (synchronous). Twilio fires
// this immediately after the voicemail is captured with the recording URL
// + caller info. We update the lead row, send the Telegram alert, and
// return Hangup TwiML so the call ends cleanly.
//
// Twilio's recording params naming on an `action` callback:
//   RecordingUrl, RecordingSid, RecordingDuration
//   From / Caller (lead's number), To / Called (the Twilio number)

const HANGUP_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup />
</Response>`

function twimlResponse(): NextResponse {
  return new NextResponse(HANGUP_TWIML, {
    headers: { "Content-Type": "text/xml" },
  })
}

export async function POST(request: Request) {
  let recordingUrl = ""
  let callerPhone = ""
  let twilioNumber = ""
  let recordingSid = ""
  try {
    const body = await request.text()
    const params = parseTwilioBody(body)
    recordingUrl = params.get("RecordingUrl") || ""
    callerPhone = params.get("From") || params.get("Caller") || ""
    twilioNumber = params.get("To") || params.get("Called") || ""
    recordingSid = params.get("RecordingSid") || ""
  } catch (e) {
    console.error("[recording] Failed to parse Twilio body:", e)
    return twimlResponse()
  }

  if (!recordingUrl || !callerPhone) {
    console.warn(`[recording] Missing fields — url:${!!recordingUrl} from:${!!callerPhone}`)
    return twimlResponse()
  }

  const fullUrl = `${recordingUrl}.mp3`
  const source = getCampaignSource(twilioNumber)
  console.log(`[recording] Processing ${recordingSid} for ${callerPhone} (${source})`)

  try {
    const sb = getLeadsClient()

    // Idempotency: if this RecordingSid is already attached, do nothing.
    const { data: existing } = await sb
      .from("leads")
      .select("id")
      .eq("recording_url", fullUrl)
      .limit(1)
    if (existing && existing.length > 0) {
      console.log(`[recording] ${recordingSid} already processed; skipping`)
      return twimlResponse()
    }

    // Filter by twilio_number too — without it, a caller who hits both
    // numbers within 15 min would have the second call's recording overwrite
    // the first call's row. Confirmed bug 2026-04-28: an MFM-A voicemail row
    // got its recording_url overwritten with the MFM-B recording.
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    let lookup = sb
      .from("leads")
      .select("id")
      .eq("caller_phone", callerPhone)
      .in("lead_type", ["voicemail", "call"])
      .gte("created_at", fifteenMinAgo)
      .order("created_at", { ascending: false })
      .limit(1)
    if (twilioNumber) lookup = lookup.eq("twilio_number", twilioNumber)
    const { data, error } = await lookup
    if (error) console.error("[recording] Lookup failed:", error)

    const id = data?.[0]?.id
    if (id) {
      const { error: updErr } = await sb
        .from("leads")
        .update({ recording_url: fullUrl, lead_type: "voicemail" })
        .eq("id", id)
      if (updErr) console.error("[recording] Update failed:", updErr)
      else console.log(`[recording] Updated lead ${id} with recording`)
    } else {
      console.warn(`[recording] No matching lead for ${callerPhone}; inserting fresh row`)
      const { error: insErr } = await sb.from("leads").insert({
        source,
        twilio_number: twilioNumber || null,
        caller_phone: callerPhone,
        lead_type: "voicemail",
        recording_url: fullUrl,
        status: "new",
      })
      if (insErr) console.error("[recording] Fallback insert failed:", insErr)
    }
  } catch (e) {
    console.error("[recording] Supabase threw:", e)
  }

  try {
    await sendTelegramAlert(
      `🎙️ New voicemail — <b>${source}</b> — ${callerPhone}\n🔗 ${fullUrl}`
    )
  } catch (e) {
    console.error("[recording] Telegram threw:", e)
  }

  return twimlResponse()
}
