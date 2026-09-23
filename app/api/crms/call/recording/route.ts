import { NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { getLeadsClient, parseTwilioBody } from "@/lib/leads"
import { processRelationshipRecording } from "@/lib/relationship-calls"

// Recording callback for Relationships calls. Attaches the recording to the
// touch, then transcribes + summarizes in the background (see
// lib/relationship-calls.ts). Public route — Twilio webhook.
export const maxDuration = 300

const HANGUP = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup /></Response>`
const ok = () => new NextResponse(HANGUP, { headers: { "Content-Type": "text/xml" } })

export async function POST(request: NextRequest) {
  const touchId = request.nextUrl.searchParams.get("touchId")
  if (!touchId) return ok()
  let recordingUrl = ""
  let durationSec: number | null = null
  try {
    const p = parseTwilioBody(await request.text())
    recordingUrl = p.get("RecordingUrl") || ""
    const d = Number(p.get("RecordingDuration") || "")
    durationSec = Number.isFinite(d) && d >= 0 ? d : null
  } catch (e) {
    console.error("[crms/call/recording] parse failed:", e)
    return ok()
  }
  if (!recordingUrl) return ok()
  const fullUrl = `${recordingUrl}.mp3`

  const sb = getLeadsClient()
  const { data: t } = await sb
    .from("relationship_touches")
    .select("relationship_id, recording_url, transcript")
    .eq("id", touchId)
    .single()
  if (!t?.relationship_id) {
    console.warn(`[crms/call/recording] touch ${touchId} not found`)
    return ok()
  }
  if (t.recording_url === fullUrl && t.transcript) return ok() // already processed
  await sb.from("relationship_touches").update({ recording_url: fullUrl }).eq("id", touchId)

  waitUntil(processRelationshipRecording({
    touchId,
    relationshipId: t.relationship_id,
    fullUrl,
    recordingDurationSec: durationSec,
  }))
  return ok()
}
