import { NextResponse } from "next/server"
import { parseTwilioBody, sendTelegramAlert } from "@/lib/leads"

// <Dial><Sip> action for the test line: Jackie's leg ended. A leg that never
// connected (OpenAI refused, timed out, SIP error) is the case the mailer
// lines will send to voicemail — here it's a Telegram alert with Twilio's
// SIP response code so the hand-off can be debugged.

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } })
}

export async function POST(request: Request) {
  let params = new URLSearchParams()
  try {
    params = parseTwilioBody(await request.text())
  } catch { /* empty body → treated as a failed leg */ }
  const status = params.get("DialCallStatus") || ""
  const duration = Number(params.get("DialCallDuration") || 0)
  if (status === "completed" && duration > 0) {
    return xml(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`)
  }
  const sipCode = params.get("DialSipResponseCode") || "?"
  const from = params.get("From") || "unknown"
  await sendTelegramAlert(
    `⚠️ AI test line: the hand-off to Jackie didn't connect (Twilio ${status || "no status"}, SIP ${sipCode}) — caller ${from}. On a mailer line this caller would have gone to voicemail.`,
  )
  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Sorry, Jackie isn't available right now. Goodbye.</Say>
  <Hangup/>
</Response>`)
}
