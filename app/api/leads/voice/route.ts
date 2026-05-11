import { NextResponse } from "next/server"
import {
  FORWARD_TO,
  getCampaignSource,
  getLeadsClient,
  OUTBOUND_TWILIO_NUMBER,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"

const OUTBOUND_CALLBACK_DEDUP_DAYS = 30

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
    const isOutboundCallback = twilioNumber === OUTBOUND_TWILIO_NUMBER
    // Landing-page Google Ads number gets its own source_type + drip path.
    // Everything else (MFM-A/B, outbound callback) stays on direct-mail.
    const isGoogleAds = twilioNumber === "+16506703914"
    // AWAIT the insert — must complete before the function exits.
    try {
      const sb = getLeadsClient()

      // Phase 7C-may8 Bug 1: when a lead dials the outbound caller-ID
      // number back, they're returning Ryan's outreach against an
      // existing lead — not a fresh intake. Look up the recent intake
      // row and skip the drip-campaign stamp so the engine doesn't kick
      // off a new cycle. The UI groups events by caller_phone, so the
      // call event still shows up on the existing card.
      let existingLeadId: string | null = null
      if (isOutboundCallback) {
        const since = new Date(
          Date.now() - OUTBOUND_CALLBACK_DEDUP_DAYS * 86_400_000
        ).toISOString()
        const { data: existing } = await sb
          .from("leads")
          .select("id")
          .eq("caller_phone", callerPhone)
          .not("twilio_number", "is", null)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(1)
        existingLeadId = existing?.[0]?.id ?? null
      }

      const insertRow: Record<string, unknown> = {
        source,
        source_type: isGoogleAds ? "google_ads" : "direct_mail",
        twilio_number: twilioNumber,
        caller_phone: callerPhone,
        lead_type: "call",
        status: "new",
      }
      if (!existingLeadId) {
        // Phase 7B: stamp drip campaign on intake. The engine's hourly
        // scan will pick up touch 0 (15-min missed-call message) when no
        // recording arrives within the buffer, and touch 1 onward at
        // each cadence step. Google Ads landing-page calls skip the
        // missed-call template and run the AI-drafted google_ads_form
        // cadence from touch 1.
        insertRow.drip_campaign_type = isGoogleAds ? "google_ads_form" : "direct_mail_call"
        insertRow.drip_touch_number = 0
        insertRow.last_drip_sent_at = new Date().toISOString()
      }

      const { error } = await sb.from("leads").insert(insertRow)
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
