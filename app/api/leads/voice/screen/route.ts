import { NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { getLeadsClient, parseTwilioBody, sendTelegramAlert } from "@/lib/leads"
import { PROD_BASE, twimlAttr } from "@/lib/relationship-calls"

// Press-1 screen on Ryan's cell leg (NOO Q4 lines, 2026-10-27).
//
// Runs on HIS end after something picks up (<Number url> in
// /api/leads/voice). When he declines or is on another call, his carrier
// voicemail picks up at once and Twilio calls that "answered" — so the
// caller never reached the Jackie coin flip. Voicemail can't press a key:
//   - he presses a key → stamp leads.ryan_picked_up_at, connect the caller
//   - nothing in 6 s  → hang up his leg; /no-answer sees no stamp and treats
//                        the call as missed (coin flip / voicemail)
// The caller hears ringing throughout. Any digit counts — the prompt says 1.

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } })
}

const HANGUP = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`

export async function POST(request: NextRequest) {
  const leadId = request.nextUrl.searchParams.get("leadId") || ""
  const step = request.nextUrl.searchParams.get("step")
  let params = new URLSearchParams()
  try {
    params = parseTwilioBody(await request.text())
  } catch { /* no digits → not accepted */ }

  if (step !== "answer") {
    const action = twimlAttr(`${PROD_BASE}/api/leads/voice/screen?step=answer&leadId=${encodeURIComponent(leadId)}`)
    return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="6" action="${action}" method="POST">
    <Say voice="Polly.Joanna">L R G lead call. Press 1 to take it.</Say>
  </Gather>
  <Hangup/>
</Response>`)
  }

  const digits = params.get("Digits") || ""
  if (!digits) return xml(HANGUP)
  if (leadId) {
    // Awaited: a few ms, and the stamp must exist before this call can end.
    const { error } = await getLeadsClient()
      .from("leads")
      .update({ ryan_picked_up_at: new Date().toISOString() })
      .eq("id", leadId)
    if (error) console.error(`[screen] pick-up stamp failed for ${leadId}: ${error.message}`)
  }
  // The conversation is recorded from here (not from answer, which would
  // catch the screen + carrier greeting on a decline). Started after the
  // legs bridge; the callback names the row so it never guesses.
  const callSid = request.nextUrl.searchParams.get("callSid") || ""
  if (callSid && leadId) waitUntil(startCallRecording(callSid, leadId))
  // Empty response = done screening; Twilio connects the two legs.
  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response/>`)
}

async function startCallRecording(callSid: string, leadId: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return
  await new Promise((r) => setTimeout(r, 400)) // let the bridge happen first
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(callSid)}/Recordings.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        RecordingChannels: "dual",
        RecordingStatusCallback: `${PROD_BASE}/api/leads/voice/recording?leadId=${encodeURIComponent(leadId)}`,
        RecordingStatusCallbackMethod: "POST",
      }).toString(),
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)
      console.error(`[screen] recording start failed ${res.status}: ${detail}`)
      await sendTelegramAlert(`⚠️ A lead call you picked up isn't being recorded (Twilio ${res.status}). Lead ${leadId}.`)
    }
  } catch (e) {
    console.error("[screen] recording start threw:", e)
  }
}
