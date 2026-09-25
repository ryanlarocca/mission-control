import { NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { getLeadsClient, parseTwilioBody } from "@/lib/leads"
import { processRelationshipRecording, type RelationshipCallKind } from "@/lib/relationship-calls"

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
  if (!touchId) return ok(voicemail)
  let recordingUrl = ""
  let durationSec: number | null = null
  try {
    const p = parseTwilioBody(await request.text())
    recordingUrl = p.get("RecordingUrl") || ""
    const d = Number(p.get("RecordingDuration") || "")
    durationSec = Number.isFinite(d) && d >= 0 ? d : null
  } catch (e) {
    console.error("[crms/call/recording] parse failed:", e)
    return ok(voicemail)
  }
  if (!recordingUrl) return ok(voicemail)
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
  }))
  return ok(voicemail)
}
