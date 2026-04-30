import { NextRequest, NextResponse } from "next/server"
import { getTwilioNumber } from "@/lib/leads"

// Twilio fetches this URL when Ryan answers the outbound leg of a call
// initiated by /api/leads/call. We return TwiML that <Dial>s the lead's
// number with both legs recorded; the recording callback threads the
// leadId back through so /api/leads/call/recording can attach the audio
// to the right Supabase row.
//
// callerId is set to the same Twilio number used as `From` on the REST
// call so the lead sees the LRG Homes number, not Ryan's cell.
//
// Public route — no `mc_session` required (Twilio webhook). Listed in
// middleware.ts PUBLIC_PATHS.

const PROD_BASE = "https://mission-control-three-chi.vercel.app"

function buildTwiml(leadPhone: string, recordingUrl: string, callerId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="30" callerId="${callerId}" record="record-from-answer" recordingStatusCallback="${recordingUrl}" recordingStatusCallbackMethod="POST">
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

  let callerId: string
  try {
    callerId = getTwilioNumber()
  } catch (e) {
    console.error("[call/bridge]", e)
    return emptyTwiml()
  }

  return new NextResponse(buildTwiml(leadPhone, recordingUrl, callerId), {
    headers: { "Content-Type": "text/xml" },
  })
}

export async function POST(request: NextRequest) {
  return handle(request)
}

export async function GET(request: NextRequest) {
  return handle(request)
}
