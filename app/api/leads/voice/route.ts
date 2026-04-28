import { NextResponse } from "next/server"
import {
  FORWARD_TO,
  getCampaignSource,
  getLeadsClient,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"

// TwiML voice webhook for LRG Homes Twilio numbers.
// Flow: ring Ryan's cell for 15s with the Twilio number as caller ID, while
// fire-and-forget logging the lead to Supabase + alerting Ryan via Telegram.
// The TwiML response must NOT block on Supabase/Telegram — caller must hear
// ringing immediately. Failures there are logged but don't break the call.

function buildTwiml(callerId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="15" action="/api/leads/voice/no-answer" method="POST" callerId="${callerId}">
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

  // Fire-and-forget: log lead + alert
  if (callerPhone) {
    const source = getCampaignSource(twilioNumber)
    void (async () => {
      try {
        const sb = getLeadsClient()
        const { error } = await sb.from("leads").insert({
          source,
          twilio_number: twilioNumber,
          caller_phone: callerPhone,
          lead_type: "call",
          status: "new",
        })
        if (error) console.error("[voice] Supabase insert failed:", error)
      } catch (e) {
        console.error("[voice] Supabase insert threw:", e)
      }
      await sendTelegramAlert(`📞 New lead call — <b>${source}</b> — ${callerPhone}`)
    })()
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
