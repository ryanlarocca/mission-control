import { NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { getLeadsClient, parseTwilioBody } from "@/lib/leads"
import { processRelationshipRecording, MIN_VOICEMAIL_TRANSCRIBE_SEC, type CallLine, type RelationshipCallKind } from "@/lib/relationship-calls"
import { alertMissedOfficeCall, isEmptyVoicemail } from "@/lib/office-inbound"

// Recording callback for Relationships calls. Attaches the recording to the
// touch, then transcribes + summarizes in the background (see
// lib/relationship-calls.ts). Public route — Twilio webhook.
export const maxDuration = 300

const HANGUP = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup /></Response>`
// The office-line voicemail <Record action> lands here too (voicemail=1);
// the TwiML we return is what the caller hears after the beep.
const THANKS = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say voice="alice">Thank you. Goodbye.</Say><Hangup /></Response>`
const ok = (voicemail = false) => new NextResponse(voicemail ? THANKS : HANGUP, { headers: { "Content-Type": "text/xml" } })

export async function POST(request: NextRequest) {
  const touchId = request.nextUrl.searchParams.get("touchId")
  const voicemail = request.nextUrl.searchParams.get("voicemail") === "1"
  // Agents line (650) 910-4007 threads line=agents (+ the campaign contact)
  // through so alerts go to the campaign bot and the summary mirrors onto
  // the campaign timeline. Office lines send neither.
  const line: CallLine = request.nextUrl.searchParams.get("line") === "agents" ? "agents" : "office"
  const campaignContactId = request.nextUrl.searchParams.get("campaignContactId")
  // The caller's number, threaded by /api/crms/call/inbound (the recording
  // callback itself carries no From). Display only.
  const fromRaw = (request.nextUrl.searchParams.get("from") || "").trim()
  const callerPhone = /^\+?\d{7,15}$/.test(fromRaw) ? fromRaw : null
  if (!touchId) return ok(voicemail)
  let recordingUrl = ""
  let durationSec: number | null = null
  let callSid: string | null = null
  try {
    const p = parseTwilioBody(await request.text())
    recordingUrl = p.get("RecordingUrl") || ""
    callSid = p.get("CallSid") || null
    const d = Number(p.get("RecordingDuration") || "")
    durationSec = Number.isFinite(d) && d >= 0 ? d : null
  } catch (e) {
    console.error("[crms/call/recording] parse failed:", e)
    return ok(voicemail)
  }
  if (!recordingUrl) {
    // An office-line voicemail <Record action> with nothing recorded: the
    // caller reached the beep and left nothing — "Missed call, no voicemail"
    // (2026-11-11). Once-only via the touch claim; the agents line has its
    // own missed-call alert at dial time.
    if (voicemail && line === "office" && isEmptyVoicemail({ hasRecording: false, durationSec, floorSec: MIN_VOICEMAIL_TRANSCRIBE_SEC })) {
      waitUntil(alertMissedOfficeCall(getLeadsClient(), touchId, {
        callerPhone,
        patch: { message: "📵 Voicemail — nothing recorded (hang-up)", call_duration_sec: durationSec },
      }).then(() => undefined, e => console.error("[crms/call/recording] missed-call alert threw:", e)))
    }
    return ok(voicemail)
  }
  const fullUrl = `${recordingUrl}.mp3`

  const sb = getLeadsClient()
  const { data: t } = await sb
    .from("relationship_touches")
    .select("relationship_id, recording_url, transcript, action")
    .eq("id", touchId)
    .single()
  if (!t?.relationship_id) {
    console.warn(`[crms/call/recording] touch ${touchId} not found`)
    return ok(voicemail)
  }
  if (t.recording_url === fullUrl && t.transcript) return ok(voicemail) // already processed
  await sb.from("relationship_touches").update({ recording_url: fullUrl }).eq("id", touchId)

  // Outbound click-to-call touches carry action="call"; office-line inbound
  // ones carry action="inbound" (lib/office-inbound.ts).
  const kind: RelationshipCallKind = voicemail ? "voicemail" : t.action === "inbound" ? "inbound" : "outbound"
  waitUntil(processRelationshipRecording({
    touchId,
    relationshipId: t.relationship_id,
    fullUrl,
    recordingDurationSec: durationSec,
    kind,
    line,
    callerPhone,
    ...(line === "agents" ? { campaign: { contactId: campaignContactId, callSid } } : {}),
  }))
  return ok(voicemail)
}
