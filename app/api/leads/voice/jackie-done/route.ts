import { NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { getLeadsClient, parseTwilioBody, sendTelegramAlert } from "@/lib/leads"
import { leadVoicemailTwiml, mergeJackieCall } from "@/lib/jackie"

// <Dial><Sip> action for a Jackie call on a mailer line (no-answer route).
// Her leg ended normally → hang up; the recording callback does the card.
// Her leg never connected (OpenAI refused / timed out / SIP error) → the
// caller gets Ryan's voicemail like any other missed call, and Telegram says
// why. The row keeps call_arm = jackie (intent to treat) with failed: true.

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } })
}

export async function POST(request: NextRequest) {
  const leadId = request.nextUrl.searchParams.get("leadId")
  let params = new URLSearchParams()
  try {
    params = parseTwilioBody(await request.text())
  } catch { /* treated as a failed leg */ }
  const status = params.get("DialCallStatus") || ""
  const duration = Number(params.get("DialCallDuration") || 0) || 0
  const connected = status === "completed" && duration > 0
  const sb = getLeadsClient()

  if (connected) {
    if (leadId) {
      waitUntil(mergeJackieCall(sb, leadId, { duration_sec: duration, ended_at: new Date().toISOString() })
        .catch((e) => console.error(`[jackie-done] ${e instanceof Error ? e.message : e}`)))
    }
    return xml(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`)
  }

  const sipCode = params.get("DialSipResponseCode") || "?"
  const from = params.get("From") || "unknown"
  if (leadId) {
    try {
      await mergeJackieCall(sb, leadId, { failed: true, failure: `${status || "no status"} / SIP ${sipCode}` })
    } catch (e) {
      console.error(`[jackie-done] ${e instanceof Error ? e.message : e}`)
    }
  }
  await sendTelegramAlert(`⚠️ Jackie didn't pick up (${status || "no status"}, SIP ${sipCode}) — ${from} went to your voicemail instead.`)
  return xml(leadVoicemailTwiml())
}
