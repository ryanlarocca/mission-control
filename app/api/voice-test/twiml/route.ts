import { NextResponse } from "next/server"
import { jackieDialTwiml } from "@/lib/jackie"
import { PROD_BASE } from "@/lib/relationship-calls"

// Twilio voice webhook for the test line (408-337-2785) since 10-27: the
// number left the SIP trunk and now reaches Jackie the way the mailer lines
// will — a <Dial><Sip> from inside a normal Twilio call (lib/jackie.ts). No
// cell ring here: the test line is for talking to Jackie.

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } })
}

export async function POST() {
  return xml(jackieDialTwiml({ tags: { line: "test" }, action: `${PROD_BASE}/api/voice-test/after` }))
}
