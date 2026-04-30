import { NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import {
  getCampaignSource,
  getLeadsClient,
  parseTwilioBody,
  processRecordingBackground,
} from "@/lib/leads"

// Recording handler — fires for both voicemails (<Record action="...">) and
// live-call recordings (<Dial recordingStatusCallback="...">). Flow:
//   1. Attach recording_url to the matching lead row (does NOT touch
//      lead_type — that was set correctly by /voice or /no-answer earlier).
//   2. Return Hangup TwiML so the caller's session ends immediately (only
//      meaningful for voicemails; harmless for the live-call callback).
//   3. waitUntil(...) the slow work: download audio → Whisper → save
//      transcription → AI triage → Telegram voice note. waitUntil keeps
//      the Vercel function alive past the response so the work finishes.
//
// Lookup window is 60 minutes because live calls can run long, and the
// recordingStatusCallback fires after the call ends.
//
// Twilio's recording params on an `action`/recordingStatusCallback:
//   RecordingUrl, RecordingSid, RecordingDuration
//   From / Caller (lead's number), To / Called (the Twilio number)

const HANGUP_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup />
</Response>`

function twimlResponse(): NextResponse {
  return new NextResponse(HANGUP_TWIML, {
    headers: { "Content-Type": "text/xml" },
  })
}

export async function POST(request: Request) {
  let recordingUrl = ""
  let callerPhone = ""
  let twilioNumber = ""
  let recordingSid = ""
  try {
    const body = await request.text()
    const params = parseTwilioBody(body)
    recordingUrl = params.get("RecordingUrl") || ""
    callerPhone = params.get("From") || params.get("Caller") || ""
    twilioNumber = params.get("To") || params.get("Called") || ""
    recordingSid = params.get("RecordingSid") || ""
  } catch (e) {
    console.error("[recording] Failed to parse Twilio body:", e)
    return twimlResponse()
  }

  if (!recordingUrl || !callerPhone) {
    console.warn(`[recording] Missing fields — url:${!!recordingUrl} from:${!!callerPhone}`)
    return twimlResponse()
  }

  const fullUrl = `${recordingUrl}.mp3`
  const source = getCampaignSource(twilioNumber)
  console.log(`[recording] Processing ${recordingSid} for ${callerPhone} (${source})`)

  // ── Step 1: synchronously attach recording_url to the lead row ──
  let leadId: string | null = null
  try {
    const sb = getLeadsClient()

    // Idempotency: if this RecordingSid is already attached, do nothing.
    const { data: existing } = await sb
      .from("leads")
      .select("id")
      .eq("recording_url", fullUrl)
      .limit(1)
    if (existing && existing.length > 0) {
      console.log(`[recording] ${recordingSid} already processed; skipping`)
      return twimlResponse()
    }

    // Filter by twilio_number too — without it, a caller who hits both
    // numbers within the window would have the second call's recording
    // overwrite the first call's row. 60 min covers long live calls.
    const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    let lookup = sb
      .from("leads")
      .select("id")
      .eq("caller_phone", callerPhone)
      .in("lead_type", ["voicemail", "call"])
      .gte("created_at", sixtyMinAgo)
      .order("created_at", { ascending: false })
      .limit(1)
    if (twilioNumber) lookup = lookup.eq("twilio_number", twilioNumber)
    const { data, error } = await lookup
    if (error) console.error("[recording] Lookup failed:", error)

    const id = data?.[0]?.id
    if (id) {
      // Only attach recording_url — leave lead_type alone. /voice already set
      // it to "call"; /no-answer already promoted it to "voicemail" if the
      // call wasn't answered.
      const { error: updErr } = await sb
        .from("leads")
        .update({ recording_url: fullUrl })
        .eq("id", id)
      if (updErr) console.error("[recording] Update failed:", updErr)
      else {
        console.log(`[recording] Updated lead ${id} with recording`)
        leadId = id
      }
    } else {
      console.warn(`[recording] No matching lead for ${callerPhone}; inserting fresh row`)
      const { data: inserted, error: insErr } = await sb
        .from("leads")
        .insert({
          source,
          source_type: "direct_mail",
          twilio_number: twilioNumber || null,
          caller_phone: callerPhone,
          lead_type: "voicemail",
          recording_url: fullUrl,
          status: "new",
        })
        .select("id")
        .single()
      if (insErr) console.error("[recording] Fallback insert failed:", insErr)
      else if (inserted) leadId = inserted.id
    }
  } catch (e) {
    console.error("[recording] Supabase threw:", e)
  }

  // ── Step 2: return Hangup TwiML immediately so the caller's call ends ──
  // The slow work (Whisper transcription + AI triage + Telegram) is queued
  // via waitUntil so it completes after the response.
  waitUntil(processRecordingBackground({
    fullUrl,
    callerPhone,
    source,
    leadId,
    direction: "inbound",
  }))

  return twimlResponse()
}
