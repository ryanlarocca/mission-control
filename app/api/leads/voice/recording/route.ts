import { NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import {
  getCampaignSource,
  getLeadsClient,
  parseTwilioBody,
  processRecordingBackground,
  isOwnedNumber,
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
// Lookup window is 4 hours: the row is created at call start and this
// callback fires after the call ends, so it must outlast any live call.
//
// Twilio's recording params on an `action`/recordingStatusCallback:
//   RecordingUrl, RecordingSid, RecordingDuration
//   From / Caller (lead's number), To / Called (the Twilio number)

// Long recordings (~25+ minutes) push the background pipeline past Vercel's
// default function budget — Whisper alone can run 30-60s on a 25-min audio
// file, plus analyze-call + a multi-MB Telegram voice upload. Without an
// explicit max the function was getting recycled before Whisper's result
// landed, silently dropping the transcript (see Gigi Williams 2026-05-16,
// plus two 27-min orphans in the prior 30 days). 300s gives waitUntil()
// room to finish the slow path on every realistic call length.
export const maxDuration = 300

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
  let recordingStatus = ""
  let recordingDurationSec: number | null = null
  let explicitLeadId = ""
  try {
    const body = await request.text()
    const params = parseTwilioBody(body)
    recordingUrl = params.get("RecordingUrl") || ""
    callerPhone = params.get("From") || params.get("Caller") || ""
    twilioNumber = params.get("To") || params.get("Called") || ""
    recordingSid = params.get("RecordingSid") || ""
    recordingStatus = params.get("RecordingStatus") || ""
    const dur = Number(params.get("RecordingDuration") || "")
    recordingDurationSec = Number.isFinite(dur) && dur >= 0 ? dur : null
    // Non-Twilio rescue scripts can pass LeadId to bypass the time-windowed
    // lookup and attach to a specific row. Twilio never sends this param.
    explicitLeadId = params.get("LeadId") || ""
  } catch (e) {
    console.error("[recording] Failed to parse Twilio body:", e)
    return twimlResponse()
  }

  if (!recordingUrl || !callerPhone) {
    console.warn(`[recording] Missing fields — url:${!!recordingUrl} from:${!!callerPhone}`)
    return twimlResponse()
  }
  // Same guard as /voice: a recording whose caller is one of our own Twilio
  // numbers is the system dialing itself (a test call, the outbound
  // caller-ID leg). /voice never wrote a lead row for it, so the fallback
  // insert below would file a phantom "voicemail" for our own number.
  if (isOwnedNumber(callerPhone)) {
    console.warn(`[recording] self-originated recording from our own number ${callerPhone} -> ${twilioNumber}; not filing a lead`)
    return twimlResponse()
  }

  // Only a finished recording can be transcribed. Twilio's real callback
  // only fires for `completed` (the default event), but a replay from the
  // rescue script — or a future callback-event change — could hand us an
  // in-progress recording. Processing one attaches recording_url, fails
  // the download, and (before 2026-09-22) stamped a live 20-min call cold;
  // the real callback then hit the idempotency check and was dropped.
  if (recordingStatus && recordingStatus !== "completed") {
    console.warn(`[recording] ${recordingSid} status=${recordingStatus} — not processing until completed`)
    return twimlResponse()
  }

  const fullUrl = `${recordingUrl}.mp3`
  const source = getCampaignSource(twilioNumber)
  console.log(`[recording] Processing ${recordingSid} for ${callerPhone} (${source})${explicitLeadId ? ` [rescue → ${explicitLeadId}]` : ""}`)

  // ── Step 1: synchronously attach recording_url to the lead row ──
  let leadId: string | null = null
  // Voicemail unless the matched row proves it was a live answered call.
  let kind: "voicemail" | "call" = "voicemail"
  try {
    const sb = getLeadsClient()

    // Idempotency for Twilio retries: if this RecordingUrl is already
    // attached AND the attached row is the same as the one we're about to
    // target, skip — but ONLY if that row actually got its transcript. A
    // row with the URL attached and `message` still NULL means an earlier
    // run attached the URL and then failed downstream (download / Whisper
    // / function recycled); re-running the pipeline on that same row is
    // exactly what we want, and it's what the rescue sweep replays.
    // We deliberately do NOT skip on the rescue path where a recording got
    // attached to a fallback row earlier (we want to re-attach to the
    // explicit LeadId); a follow-up cleanup deletes the stale fallback row.
    const { data: existing } = await sb
      .from("leads")
      .select("id, lead_type, message")
      .eq("recording_url", fullUrl)
      .limit(1)
    let retryRowId: string | null = null
    if (existing && existing.length > 0) {
      if (!explicitLeadId || existing[0].id === explicitLeadId) {
        if (existing[0].message) {
          console.log(`[recording] ${recordingSid} already processed; skipping`)
          return twimlResponse()
        }
        console.warn(`[recording] ${recordingSid} attached to lead ${existing[0].id} but never transcribed; re-running the pipeline`)
        retryRowId = existing[0].id
        if (existing[0].lead_type === "call") kind = "call"
      } else {
        console.log(`[recording] ${recordingSid} attached elsewhere (lead ${existing[0].id}); rescue path re-attaching to ${explicitLeadId}`)
      }
    }

    let id: string | null = null
    if (retryRowId) {
      id = retryRowId
    } else if (explicitLeadId) {
      const { data: rescued } = await sb.from("leads").select("lead_type").eq("id", explicitLeadId).maybeSingle()
      if (rescued?.lead_type === "call") kind = "call"
      // Rescue path: caller (cron / batch script) already identified the
      // specific orphan row to attach to. Skip the time-window lookup
      // entirely so we don't fall back to inserting a new voicemail row
      // when the orphan is older than the 60-min window.
      id = explicitLeadId
    } else {
      // Filter by twilio_number too — without it, a caller who hits both
      // numbers within the window would have the second call's recording
      // overwrite the first call's row. The row is created when the call
      // STARTS and this callback fires when it ENDS, so the window must
      // exceed the longest call Ryan will ever take — 4h, not 60 min.
      const windowStart = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      let lookup = sb
        .from("leads")
        .select("id, lead_type")
        .eq("caller_phone", callerPhone)
        .in("lead_type", ["voicemail", "call"])
        .gte("created_at", windowStart)
        .order("created_at", { ascending: false })
        .limit(1)
      if (twilioNumber) lookup = lookup.eq("twilio_number", twilioNumber)
      const { data, error } = await lookup
      if (error) console.error("[recording] Lookup failed:", error)
      id = data?.[0]?.id ?? null
      // /no-answer promoted the row to "voicemail" when Ryan didn't pick up;
      // a row still typed "call" means this is the live-conversation
      // recording from <Dial record-from-answer>.
      if (data?.[0]?.lead_type === "call") kind = "call"
    }

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
    kind,
    recordingDurationSec,
  }))

  return twimlResponse()
}
