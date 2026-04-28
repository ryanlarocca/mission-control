import { NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import {
  fetchTwilioAudio,
  getCampaignSource,
  getLeadsClient,
  parseTwilioBody,
  sendTelegramAlert,
  sendTelegramVoice,
  transcribeAudio,
} from "@/lib/leads"

// Called as the <Record action="..."> target (synchronous). Twilio fires
// this immediately after the voicemail is captured with the recording URL
// + caller info. Flow:
//   1. Synchronously update the lead row (recording_url + lead_type=voicemail)
//      so the Leads tab can render the audio player as soon as it loads.
//   2. Return Hangup TwiML immediately so the caller doesn't sit through
//      silence while Whisper + Telegram run.
//   3. waitUntil(...) the slow work: download audio → Whisper transcription
//      → save transcription → send Telegram voice note. waitUntil keeps the
//      Vercel function alive past the response so the work actually finishes
//      (plain fire-and-forget gets killed in serverless).
//
// Twilio's recording params on an `action` callback:
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
    // numbers within 15 min would have the second call's recording overwrite
    // the first call's row.
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    let lookup = sb
      .from("leads")
      .select("id")
      .eq("caller_phone", callerPhone)
      .in("lead_type", ["voicemail", "call"])
      .gte("created_at", fifteenMinAgo)
      .order("created_at", { ascending: false })
      .limit(1)
    if (twilioNumber) lookup = lookup.eq("twilio_number", twilioNumber)
    const { data, error } = await lookup
    if (error) console.error("[recording] Lookup failed:", error)

    const id = data?.[0]?.id
    if (id) {
      const { error: updErr } = await sb
        .from("leads")
        .update({ recording_url: fullUrl, lead_type: "voicemail" })
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
  // The slow work (Whisper transcription + Telegram voice send) is queued
  // via waitUntil so it completes after the response.
  waitUntil(processVoicemailBackground({
    fullUrl,
    callerPhone,
    source,
    leadId,
  }))

  return twimlResponse()
}

async function processVoicemailBackground(args: {
  fullUrl: string
  callerPhone: string
  source: string
  leadId: string | null
}): Promise<void> {
  const { fullUrl, callerPhone, source, leadId } = args
  try {
    // Download the audio once — used for both Whisper and Telegram voice.
    const audio = await fetchTwilioAudio(fullUrl)

    let transcription: string | null = null
    if (audio) {
      transcription = await transcribeAudio(audio)
      if (transcription && leadId) {
        // Store transcription in the existing `message` column rather than
        // adding a `transcription` column. For voicemail rows, `message` is
        // otherwise null — see lib/leads.ts conventions comment.
        try {
          const sb = getLeadsClient()
          const { error } = await sb
            .from("leads")
            .update({ message: transcription })
            .eq("id", leadId)
          if (error) console.error("[recording-bg] Transcription save failed:", error)
          else console.log(`[recording-bg] Saved transcription for lead ${leadId}`)
        } catch (e) {
          console.error("[recording-bg] Transcription save threw:", e)
        }
      }
    }

    // Build Telegram caption — include transcription if we have it.
    const captionLines = [`🎙️ New voicemail — <b>${source}</b> — ${callerPhone}`]
    if (transcription) {
      captionLines.push("", `📝 ${transcription}`)
    } else {
      captionLines.push("", `🔗 ${fullUrl}`)
    }
    const caption = captionLines.join("\n")

    if (audio) {
      await sendTelegramVoice(audio, caption)
    } else {
      // No audio — fall back to text-only with the URL
      await sendTelegramAlert(caption)
    }
  } catch (e) {
    console.error("[recording-bg] Threw:", e)
  }
}
