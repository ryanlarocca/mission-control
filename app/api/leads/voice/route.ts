import { NextResponse } from "next/server"
import {
  FORWARD_TO,
  getCampaignSource,
  getLeadsClient,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"

// TwiML voice webhook for LRG Homes Twilio numbers.
// Flow: log the lead row, then return Dial TwiML so Ryan's cell rings with
// the Twilio number as caller ID. The brief originally specified
// fire-and-forget for the Supabase insert + Telegram alert "so the caller
// hears ringing immediately" — but in Vercel serverless the function gets
// terminated when the response is flushed, so the insert silently dropped
// for some calls (Telegram fired, Supabase row missing). We now AWAIT the
// insert before responding. Adds ~150ms to TwiML latency, which is
// imperceptible to the caller. Telegram stays fire-and-forget after the
// response since it's not load-bearing for the data layer.

// `record="record-from-answer"` records both legs of the live call (silently —
// disclosure TwiML will be added later as a separate change). When the
// recording is ready Twilio fires `recordingStatusCallback`, which hits the
// same endpoint used for voicemails — that handler attaches recording_url +
// triggers Whisper + AI triage. The absolute URL is required because Twilio
// can't resolve relative URLs on a recordingStatusCallback.
const RECORDING_CALLBACK_URL =
  "https://mission-control-three-chi.vercel.app/api/leads/voice/recording"

function buildTwiml(callerId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="10" action="/api/leads/voice/no-answer" method="POST" callerId="${callerId}" record="record-from-answer" recordingStatusCallback="${RECORDING_CALLBACK_URL}" recordingStatusCallbackMethod="POST">
    <Number>${FORWARD_TO}</Number>
  </Dial>
</Response>`
}

export async function POST(request: Request) {
  let twilioNumber = FORWARD_TO
  let callerPhone = ""
  try {
    const body = await request.text()
    const params = parseTwilioBody(body)
    twilioNumber = params.get("To") || FORWARD_TO
    callerPhone = params.get("From") || ""
  } catch (e) {
    console.error("[voice] Failed to parse Twilio body:", e)
  }

  if (callerPhone) {
    const source = getCampaignSource(twilioNumber)
    // AWAIT the insert — must complete before the function exits.
    try {
      const sb = getLeadsClient()
      const { error } = await sb.from("leads").insert({
        source,
        source_type: "direct_mail",
        twilio_number: twilioNumber,
        caller_phone: callerPhone,
        lead_type: "call",
        status: "new",
      })
      if (error) console.error("[voice] Supabase insert failed:", error)
    } catch (e) {
      console.error("[voice] Supabase insert threw:", e)
    }
    // Telegram stays fire-and-forget — sendTelegramAlert is best-effort.
    void sendTelegramAlert(`📞 New lead call — <b>${source}</b> — ${callerPhone}`)
  }

  return new NextResponse(buildTwiml(twilioNumber), {
    headers: { "Content-Type": "text/xml" },
  })
}

export async function GET() {
  // GET fallback — no Twilio body, just return the dial TwiML
  return new NextResponse(buildTwiml(FORWARD_TO), {
    headers: { "Content-Type": "text/xml" },
  })
}
