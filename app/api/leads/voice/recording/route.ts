import { NextResponse } from "next/server"
import {
  getCampaignSource,
  getLeadsClient,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"

// Twilio fires this when a voicemail recording is ready. We attach the URL
// to the most recent voicemail-flagged lead for that caller and alert Ryan.
// Twilio just needs a 200 to acknowledge.

export async function POST(request: Request) {
  let recordingUrl = ""
  let callerPhone = ""
  let twilioNumber = ""
  try {
    const body = await request.text()
    const params = parseTwilioBody(body)
    recordingUrl = params.get("RecordingUrl") || ""
    callerPhone = params.get("From") || params.get("Caller") || ""
    twilioNumber = params.get("To") || params.get("Called") || ""
  } catch (e) {
    console.error("[recording] Failed to parse Twilio body:", e)
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  if (!recordingUrl || !callerPhone) {
    console.warn(`[recording] Missing fields — url:${!!recordingUrl} from:${!!callerPhone}`)
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  const fullUrl = `${recordingUrl}.mp3`
  const source = getCampaignSource(twilioNumber)

  try {
    const sb = getLeadsClient()
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const { data, error } = await sb
      .from("leads")
      .select("id")
      .eq("caller_phone", callerPhone)
      .eq("lead_type", "voicemail")
      .gte("created_at", fifteenMinAgo)
      .order("created_at", { ascending: false })
      .limit(1)
    if (error) console.error("[recording] Lookup failed:", error)

    const id = data?.[0]?.id
    if (id) {
      const { error: updErr } = await sb
        .from("leads")
        .update({ recording_url: fullUrl })
        .eq("id", id)
      if (updErr) console.error("[recording] Update failed:", updErr)
    } else {
      // No matching voicemail row — insert a fresh one so the recording
      // isn't orphaned.
      console.warn(`[recording] No voicemail lead found for ${callerPhone}; inserting fresh row`)
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

  await sendTelegramAlert(
    `🎙️ New voicemail — <b>${source}</b> — ${callerPhone}\n🔗 ${fullUrl}`
  )

  return NextResponse.json({ ok: true }, { status: 200 })
}
