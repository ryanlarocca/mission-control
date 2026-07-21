import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, sendTelegramAlert } from "@/lib/leads"

// Agents line — post-<Dial> action. Answered → log metadata (no recording,
// CA two-party) + Telegram follow-up. No answer / busy / failed → take a
// voicemail (consented by nature); the recording callback logs + alerts.

export const dynamic = "force-dynamic"

const RECORDING_CALLBACK =
  "https://mission-control-three-chi.vercel.app/api/campaign/voice/recording"

export async function POST(request: NextRequest) {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(await request.text())
  } catch {
    params = new URLSearchParams()
  }
  const from = params.get("From") || ""
  const digits = from.replace(/\D/g, "").slice(-10)
  const dialStatus = params.get("DialCallStatus") || ""
  const duration = Number(params.get("DialCallDuration") || 0)

  const sb = getLeadsClient()
  const { data } = await sb
    .from("campaign_contacts")
    .select("id, name, touch_number")
    .or(`phone.eq.${digits},alt_phones.cs.{${digits}}`)
    .limit(1)
  const contact = data?.[0] ?? null
  const who = contact?.name ?? from

  if (dialStatus === "completed" && duration > 0) {
    await sb.from("campaign_events").insert({
      contact_id: contact?.id ?? null,
      kind: "call_answered",
      caller_number: digits || null,
      duration_seconds: duration,
      body: `answered call, ${duration}s`,
      raw: { from, dial_status: dialStatus },
    })
    await sendTelegramAlert(
      `📞 Talked to <b>${who}</b> — ${Math.round(duration / 60)}m${duration % 60}s on the agents line. Timeline updated; drip continues as scheduled.`
    )
    return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
      headers: { "Content-Type": "text/xml" },
    })
  }

  // Missed — roll to voicemail.
  await sb.from("campaign_events").insert({
    contact_id: contact?.id ?? null,
    kind: "call_missed",
    caller_number: digits || null,
    body: `missed call (${dialStatus})`,
    raw: { from, dial_status: dialStatus },
  })
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">You've reached Ryan LaRocca with L R G Homes. Leave a message and I'll get right back to you.</Say>
  <Record maxLength="120" playBeep="true" recordingStatusCallback="${RECORDING_CALLBACK}" recordingStatusCallbackMethod="POST"/>
</Response>`
  return new NextResponse(twiml, { headers: { "Content-Type": "text/xml" } })
}
