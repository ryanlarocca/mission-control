import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, sendTelegramAlert } from "@/lib/leads"

// Agents line — voicemail recording callback. Logs the voicemail on the
// contact timeline + Telegram alert with the recording link. (Whisper
// transcription + AI triage: Phase 5b follow-up — the recording URL is
// stored so a later pass can transcribe retroactively.)

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(await request.text())
  } catch {
    params = new URLSearchParams()
  }
  const recordingUrl = params.get("RecordingUrl") || ""
  const duration = Number(params.get("RecordingDuration") || 0)
  const callSid = params.get("CallSid") || ""
  if (!recordingUrl) return NextResponse.json({ ok: true })

  const sb = getLeadsClient()
  // The recording callback carries no From — match via the call_missed event
  // we just logged for this CallSid, else leave unlinked for manual triage.
  const { data: missed } = await sb
    .from("campaign_events")
    .select("id, contact_id, caller_number")
    .eq("kind", "call_missed")
    .filter("raw->>from", "not.is", null)
    .order("occurred_at", { ascending: false })
    .limit(5)
  const digitsByCall = missed?.[0] // best-effort: most recent missed call
  const contactId = digitsByCall?.contact_id ?? null

  let who = "unknown caller"
  if (contactId) {
    const { data: c } = await sb.from("campaign_contacts").select("name").eq("id", contactId).limit(1)
    who = c?.[0]?.name ?? who
  } else if (digitsByCall?.caller_number) {
    who = digitsByCall.caller_number
  }

  await sb.from("campaign_events").insert({
    contact_id: contactId,
    kind: "voicemail",
    caller_number: digitsByCall?.caller_number ?? null,
    duration_seconds: duration,
    body: `voicemail (${duration}s): ${recordingUrl}`,
    raw: { recording_url: recordingUrl, call_sid: callSid },
  })
  await sendTelegramAlert(
    `🎙 <b>Voicemail on the agents line</b> — ${who} (${duration}s)\n${recordingUrl}.mp3`
  )
  return NextResponse.json({ ok: true })
}
