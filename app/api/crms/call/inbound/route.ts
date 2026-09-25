import { NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { getLeadsClient, parseTwilioBody } from "@/lib/leads"
import { PROD_BASE, callOutcomeMessage } from "@/lib/relationship-calls"

// <Dial action> for INBOUND calls on the office lines that resolved to a
// Relationships contact (brief: BRIEF_OFFICE_LINE_INBOUND_2026-09-24). The
// Relationships counterpart of /api/leads/voice/no-answer.
//
//   completed  → Ryan answered; the live recording is already on its way to
//                /api/crms/call/recording. Stamp the touch + last_contacted_at
//                and hang up.
//   anything else → play the voicemail greeting and record. The Record
//                `action` posts the recording params synchronously to the
//                same recording route with voicemail=1.
//
// Public route — Twilio webhook, listed in middleware.ts PUBLIC_PATHS.

const GREETING_URL = `${PROD_BASE}/voicemail-greeting.mp3`

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } })
}
const HANGUP = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup /></Response>`

function voicemailTwiml(touchId: string): string {
  const action = `${PROD_BASE}/api/crms/call/recording?touchId=${encodeURIComponent(touchId)}&voicemail=1`
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${GREETING_URL}</Play>
  <Record maxLength="120" timeout="5" transcribe="false" action="${action}" method="POST" />
  <Say voice="alice">Thank you. Goodbye.</Say>
</Response>`
}

export async function POST(request: NextRequest) {
  const touchId = request.nextUrl.searchParams.get("touchId")
  let status = ""
  let duration: number | null = null
  try {
    const params = parseTwilioBody(await request.text())
    status = params.get("DialCallStatus") || ""
    const d = Number(params.get("DialCallDuration") || "")
    duration = Number.isFinite(d) ? d : null
  } catch (e) {
    console.error("[crms/call/inbound] parse failed:", e)
  }
  if (!touchId) return xml(HANGUP)
  console.log(`[crms/call/inbound] touch ${touchId} → ${status || "?"} (${duration ?? 0}s)`)

  const answered = status === "completed"
  waitUntil((async () => {
    try {
      const sb = getLeadsClient()
      const message = answered
        ? "📲 Inbound call — connected, transcribing…"
        : "📨 Inbound call — went to voicemail"
      const outcome = answered ? null : callOutcomeMessage(status)
      const { data: t } = await sb
        .from("relationship_touches")
        .update({ call_status: answered ? "completed" : "voicemail", call_duration_sec: duration, message: outcome ? `${message} (${outcome.replace(/^📵 /, "")})` : message })
        .eq("id", touchId)
        .is("transcript", null)
        .select("relationship_id")
        .single()
      if (answered && t?.relationship_id) {
        const { error } = await sb
          .from("relationships")
          .update({ last_contacted_at: new Date().toISOString() })
          .eq("id", t.relationship_id)
        if (error) console.error("[crms/call/inbound] last_contacted_at failed:", error.message)
      }
    } catch (e) {
      console.error("[crms/call/inbound] threw:", e)
    }
  })())

  return xml(answered ? HANGUP : voicemailTwiml(touchId))
}

export async function GET(request: NextRequest) {
  const touchId = request.nextUrl.searchParams.get("touchId") || "preview"
  return xml(voicemailTwiml(touchId))
}
