import { NextRequest, NextResponse } from "next/server"
import { PROD_BASE, relationshipCallerId } from "@/lib/relationship-calls"

// Twilio fetches this when Ryan answers the first leg of a call placed from
// /api/crms/call. We <Dial> the contact with Ryan's own cell as caller ID
// (a Twilio Verified Caller ID — a warm contact sees Ryan, not a marketing
// line) and record from answer. The caller ID is never taken from the query:
// this route is public (Twilio webhook, middleware PUBLIC_PATHS).

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } })
}
const HANGUP = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup /></Response>`

function handle(request: NextRequest): NextResponse {
  const touchId = request.nextUrl.searchParams.get("touchId")
  const to = request.nextUrl.searchParams.get("to")
  if (!touchId || !to || !/^\+\d{10,15}$/.test(to)) {
    console.warn("[crms/call/bridge] missing/invalid touchId or to")
    return xml(HANGUP)
  }
  const recordingUrl = `${PROD_BASE}/api/crms/call/recording?touchId=${encodeURIComponent(touchId)}`
  const statusUrl = `${PROD_BASE}/api/crms/call/status?touchId=${encodeURIComponent(touchId)}`
  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="30" callerId="${relationshipCallerId()}" action="${statusUrl}" method="POST" record="record-from-answer" recordingStatusCallback="${recordingUrl}" recordingStatusCallbackMethod="POST">
    <Number>${to}</Number>
  </Dial>
</Response>`)
}

export async function POST(request: NextRequest) { return handle(request) }
export async function GET(request: NextRequest) { return handle(request) }
