import { NextResponse } from "next/server"
import { jackieDialTwiml } from "@/lib/jackie"
import { parseTwilioBody } from "@/lib/leads"
import { PROD_BASE, twimlAttr } from "@/lib/relationship-calls"
import { VOICE_BAKEOFF, bakeoffOption } from "@/lib/voiceTest"

// Twilio voice webhook for the test line (408-337-2785) since 10-27: the
// number left the SIP trunk and now reaches Jackie the way the mailer lines
// will — a <Dial><Sip> from inside a normal Twilio call (lib/jackie.ts). No
// cell ring here: the test line is for talking to Jackie.
//
// 11-25 script side test: the call opens on a keypad menu (lib/voiceTest
// VOICE_BAKEOFF). The pressed digit rides to the accept route as the
// x-lrg-pick SIP header. No key within a few seconds → the live script.

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } })
}

const SELF = `${PROD_BASE}/api/voice-test/twiml`

export async function POST(request: Request) {
  const url = new URL(request.url)
  let params = new URLSearchParams()
  try {
    params = parseTwilioBody(await request.text())
  } catch { /* no body → menu */ }

  const digits = params.get("Digits")
  const option = bakeoffOption(digits)
  if (option) {
    return xml(jackieDialTwiml({ tags: { line: "test", pick: option.digit }, action: `${PROD_BASE}/api/voice-test/after` }))
  }
  // Menu timed out (or a key that isn't on it, second time round): plain Jackie.
  if (url.searchParams.get("menu") === "done") {
    return xml(jackieDialTwiml({ tags: { line: "test" }, action: `${PROD_BASE}/api/voice-test/after` }))
  }

  const prompt = VOICE_BAKEOFF.map((o) => `Press ${o.digit} for ${o.spoken}.`).join(" ")
  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="6" action="${twimlAttr(SELF)}" method="POST">
    <Say voice="Polly.Joanna">${prompt}</Say>
  </Gather>
  <Redirect method="POST">${twimlAttr(`${SELF}?menu=done`)}</Redirect>
</Response>`)
}
