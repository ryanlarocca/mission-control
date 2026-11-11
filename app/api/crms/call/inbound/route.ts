import { NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { getLeadsClient, parseTwilioBody } from "@/lib/leads"
import { PROD_BASE, callOutcomeMessage, twimlAttr } from "@/lib/relationship-calls"
import { alertMissedOfficeCall, callerHungUpWhileRinging, callIsOver, GREETING_CHECK_MS, MISSED_CALL_STATUS, RECORD_SETTLE_MS } from "@/lib/office-inbound"

// The TwiML goes back at once; the greeting re-check (see below) then waits
// ~45 s inside waitUntil, so the function must be allowed to live that long.
export const maxDuration = 60

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
//   caller gone  → (2026-11-11) the caller hung up while it was ringing
//                (DialCallStatus "canceled"): no voicemail can follow, so
//                this is where "📵 Missed call … No voicemail." goes out.
//                A caller who hangs up at the beep is the recording
//                route's business. One who hangs up DURING the greeting
//                triggers no Twilio callback at all, so after sending a call
//                to voicemail this handler looks again ~40 s later: call
//                over and no recording on the touch → the same alert (see
//                lib/office-inbound alertMissedOfficeCall).
//
// Public route — Twilio webhook, listed in middleware.ts PUBLIC_PATHS.

const GREETING_URL = `${PROD_BASE}/voicemail-greeting.mp3`

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } })
}
const HANGUP = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup /></Response>`

// `from` = the caller's number, threaded to the recording route (Twilio's
// recording callback carries no From) so a "missed call" alert can show the
// number they actually called from.
function voicemailTwiml(touchId: string, from?: string | null): string {
  const action = twimlAttr(`${PROD_BASE}/api/crms/call/recording?touchId=${encodeURIComponent(touchId)}&voicemail=1${from ? `&from=${encodeURIComponent(from)}` : ""}`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${GREETING_URL}</Play>
  <Record maxLength="120" timeout="5" transcribe="false" action="${action}" method="POST" />
  <Say voice="alice">Thank you. Goodbye.</Say>
</Response>`
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The call's current status from Twilio's REST API; null when it can't be read (then nothing alerts). */
async function twilioCallStatus(callSid: string): Promise<string | null> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return null
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(callSid)}.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
    })
    if (!res.ok) {
      console.warn(`[crms/call/inbound] Twilio call lookup ${callSid}: HTTP ${res.status}`)
      return null
    }
    const data = (await res.json()) as { status?: string }
    return data.status ?? null
  } catch (e) {
    console.warn("[crms/call/inbound] Twilio call lookup threw:", e instanceof Error ? e.message : String(e))
    return null
  }
}

export async function POST(request: NextRequest) {
  const touchId = request.nextUrl.searchParams.get("touchId")
  let status = ""
  let duration: number | null = null
  let parentStatus = ""
  let parentSid: string | null = null
  let from: string | null = null
  try {
    const params = parseTwilioBody(await request.text())
    status = params.get("DialCallStatus") || ""
    parentStatus = params.get("CallStatus") || ""
    parentSid = params.get("CallSid") || null
    const f = (params.get("From") || "").trim()
    from = /^\+?\d{7,15}$/.test(f) ? f : null // "Anonymous" etc. is not a number
    const d = Number(params.get("DialCallDuration") || "")
    duration = Number.isFinite(d) ? d : null
  } catch (e) {
    console.error("[crms/call/inbound] parse failed:", e)
  }
  if (!touchId) return xml(HANGUP)
  console.log(`[crms/call/inbound] touch ${touchId} → ${status || "?"} (${duration ?? 0}s)`)

  const answered = status === "completed"
  const callerGone = callerHungUpWhileRinging(status, parentStatus)
  waitUntil((async () => {
    try {
      const sb = getLeadsClient()
      if (callerGone) {
        const outcome = callOutcomeMessage(status)
        const message = `📵 Caller hung up before anyone answered${outcome ? ` (${outcome.replace(/^📵 /, "")})` : ""} — no voicemail`
        const r = await alertMissedOfficeCall(sb, touchId, { callerPhone: from, patch: { message, call_duration_sec: duration } })
        // "ineligible" = not a touch we can alert on (already answered /
        // gone): leave it to the voicemail stamp below, as before.
        if (r !== "ineligible") return
      }
      const message = answered
        ? "📲 Inbound call — connected, transcribing…"
        : "📨 Inbound call — went to voicemail"
      const outcome = answered ? null : callOutcomeMessage(status)
      const { data: t } = await sb
        .from("relationship_touches")
        .update({ call_status: answered ? "completed" : "voicemail", call_duration_sec: duration, message: outcome ? `${message} (${outcome.replace(/^📵 /, "")})` : message })
        .eq("id", touchId)
        .is("transcript", null)
        // A retried callback must not walk a "missed" touch (alert already
        // sent) back to "voicemail".
        .or(`call_status.is.null,call_status.neq.${MISSED_CALL_STATUS}`)
        .select("relationship_id")
        .single()
      if (answered && t?.relationship_id) {
        const { error } = await sb
          .from("relationships")
          .update({ last_contacted_at: new Date().toISOString() })
          .eq("id", t.relationship_id)
        if (error) console.error("[crms/call/inbound] last_contacted_at failed:", error.message)
      }
      // Sent to voicemail: did they hang up during the greeting? Nothing
      // tells us, so ask Twilio once the greeting has played. Still on the
      // line = they're recording; the <Record action> takes it from there.
      if (!answered && parentSid) {
        await sleep(GREETING_CHECK_MS)
        if (callIsOver(await twilioCallStatus(parentSid))) {
          await sleep(RECORD_SETTLE_MS)
          await alertMissedOfficeCall(sb, touchId, {
            callerPhone: from,
            noRecording: true,
            patch: { message: "📵 Caller hung up during the voicemail greeting — no voicemail" },
          })
        }
      }
    } catch (e) {
      console.error("[crms/call/inbound] threw:", e)
    }
  })())

  return xml(answered ? HANGUP : voicemailTwiml(touchId, from))
}

export async function GET(request: NextRequest) {
  const touchId = request.nextUrl.searchParams.get("touchId") || "preview"
  return xml(voicemailTwiml(touchId))
}
