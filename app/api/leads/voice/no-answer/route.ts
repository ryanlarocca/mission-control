import { NextResponse } from "next/server"
import { getLeadsClient, parseTwilioBody } from "@/lib/leads"

// Called when the original Dial leg ends (Ryan answered, declined, or
// didn't pick up). DialCallStatus = "completed" means he answered and the
// call is done — just hang up. Otherwise, play the voicemail greeting and
// record. Twilio calls /api/leads/voice/recording when the recording is ready.

const PROD_BASE = "https://mission-control-three-chi.vercel.app"
const GREETING_URL = `${PROD_BASE}/voicemail-greeting.mp3`
// Use Record's `action` (synchronous, fires immediately with recording params)
// instead of `recordingStatusCallback` (async, was not firing reliably). Without
// `action`, Twilio falls back to the parent Dial action URL after recording —
// which sends the recording params to /no-answer and triggers a re-record loop.
const RECORDING_HANDLER_URL = `${PROD_BASE}/api/leads/voice/recording`

function hangupTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup />
</Response>`
}

function recordTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${GREETING_URL}</Play>
  <Record maxLength="120" timeout="5" transcribe="false"
    action="${RECORDING_HANDLER_URL}"
    method="POST" />
  <Say voice="alice">Thank you. Goodbye.</Say>
</Response>`
}

export async function POST(request: Request) {
  let dialStatus = ""
  let callerPhone = ""
  try {
    const body = await request.text()
    const params = parseTwilioBody(body)
    dialStatus = params.get("DialCallStatus") || ""
    callerPhone = params.get("From") || params.get("Caller") || ""
  } catch (e) {
    console.error("[no-answer] Failed to parse Twilio body:", e)
  }

  // Caller reached voicemail — flag the existing lead row so the recording
  // callback can find it. Fire-and-forget: don't block the TwiML response.
  if (dialStatus !== "completed" && callerPhone) {
    void (async () => {
      try {
        const sb = getLeadsClient()
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
        const { data, error } = await sb
          .from("leads")
          .select("id")
          .eq("caller_phone", callerPhone)
          .gte("created_at", fiveMinAgo)
          .order("created_at", { ascending: false })
          .limit(1)
        if (error) {
          console.error("[no-answer] Lookup failed:", error)
          return
        }
        const id = data?.[0]?.id
        if (!id) {
          console.warn(`[no-answer] No recent lead for ${callerPhone}`)
          return
        }
        const { error: updErr } = await sb
          .from("leads")
          .update({ lead_type: "voicemail" })
          .eq("id", id)
        if (updErr) console.error("[no-answer] Update failed:", updErr)
      } catch (e) {
        console.error("[no-answer] Threw:", e)
      }
    })()
  }

  const twiml = dialStatus === "completed" ? hangupTwiml() : recordTwiml()
  return new NextResponse(twiml, {
    headers: { "Content-Type": "text/xml" },
  })
}

export async function GET() {
  return new NextResponse(recordTwiml(), {
    headers: { "Content-Type": "text/xml" },
  })
}
