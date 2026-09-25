import { NextRequest, NextResponse } from "next/server"
import { getTwilioNumber, isOwnedNumber } from "@/lib/leads"
import { relationshipCallerId } from "@/lib/relationship-calls"

// Twilio fetches this URL when Ryan answers the outbound leg of a call
// initiated by /api/leads/call. We return TwiML that <Dial>s the lead's
// number with both legs recorded; the recording callback threads the
// leadId back through so /api/leads/call/recording can attach the audio
// to the right Supabase row.
//
// callerId is the line /api/leads/call chose (the one the lead originally
// called/texted), passed through the `callerId` query param and accepted
// only if it is one of our own numbers OR Ryan's Twilio-verified cell (the
// "My Cell" lead path, 2026-09-25) — this route is public, so an arbitrary
// value must never become a spoofed caller ID. Falls back to the
// `TWILIO_NUMBER` env. The lead sees the LRG Homes line they know, or
// Ryan's cell when he has flagged the lead "My Cell".
//
// Public route — no `mc_session` required (Twilio webhook). Listed in
// middleware.ts PUBLIC_PATHS.

const PROD_BASE = "https://mission-control-three-chi.vercel.app"

// `action` fires when the lead's leg ends (answered-and-hung-up OR never
// answered) so an unanswered call is recorded as such — see /call/status.
function buildTwiml(leadPhone: string, recordingUrl: string, statusUrl: string, callerId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="30" callerId="${callerId}" action="${statusUrl}" method="POST" record="record-from-answer" recordingStatusCallback="${recordingUrl}" recordingStatusCallbackMethod="POST">
    <Number>${leadPhone}</Number>
  </Dial>
</Response>`
}

function emptyTwiml(): NextResponse {
  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup /></Response>`,
    { headers: { "Content-Type": "text/xml" } }
  )
}

function handle(request: NextRequest): NextResponse {
  const url = request.nextUrl
  const leadPhone = url.searchParams.get("leadPhone")
  const leadId = url.searchParams.get("leadId")

  if (!leadPhone || !leadId) {
    console.warn("[call/bridge] Missing leadPhone or leadId in query")
    return emptyTwiml()
  }

  const recordingUrl =
    `${PROD_BASE}/api/leads/call/recording?leadId=${encodeURIComponent(leadId)}`
  const statusUrl =
    `${PROD_BASE}/api/leads/call/status?leadId=${encodeURIComponent(leadId)}`

  let callerId: string
  try {
    callerId = getTwilioNumber()
  } catch (e) {
    console.error("[call/bridge]", e)
    return emptyTwiml()
  }
  const requested = url.searchParams.get("callerId")?.trim()
  if (requested && (isOwnedNumber(requested) || requested === relationshipCallerId())) callerId = requested
  else if (requested) console.warn(`[call/bridge] ignoring non-owned callerId ${requested}`)

  return new NextResponse(buildTwiml(leadPhone, recordingUrl, statusUrl, callerId), {
    headers: { "Content-Type": "text/xml" },
  })
}

export async function POST(request: NextRequest) {
  return handle(request)
}

export async function GET(request: NextRequest) {
  return handle(request)
}
