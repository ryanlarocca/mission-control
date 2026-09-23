import { NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import {
  getLeadsClient,
  parseTwilioBody,
  processRecordingBackground,
} from "@/lib/leads"

// Recording callback for outbound calls initiated via /api/leads/call.
// Twilio posts here when the bridged call's recording is ready. We attach
// the recording_url to the row identified by `leadId` (passed through the
// query string from the bridge URL), then run the same waitUntil pipeline
// the inbound recording route uses (download → Whisper → Telegram).
//
// Inbound recordings find the row by caller_phone + twilio_number lookup;
// outbound rows have twilio_number=null per the convention, so we lean on
// the leadId query param instead of replicating the lookup window.
//
// Public route — Twilio webhook, listed in middleware.ts PUBLIC_PATHS.

// See app/api/leads/voice/recording/route.ts for the rationale — the outbound
// path runs the same heavy waitUntil pipeline (Whisper + summarize +
// analyze-call + Telegram). Same risk of silent transcript drop on long
// calls without the explicit budget.
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

export async function POST(request: NextRequest) {
  const leadId = request.nextUrl.searchParams.get("leadId")
  if (!leadId) {
    console.warn("[call/recording] Missing leadId in query")
    return twimlResponse()
  }

  let recordingUrl = ""
  let recordingSid = ""
  let recordingDurationSec: number | null = null
  try {
    const body = await request.text()
    const params = parseTwilioBody(body)
    recordingUrl = params.get("RecordingUrl") || ""
    recordingSid = params.get("RecordingSid") || ""
    const dur = Number(params.get("RecordingDuration") || "")
    recordingDurationSec = Number.isFinite(dur) && dur >= 0 ? dur : null
  } catch (e) {
    console.error("[call/recording] Failed to parse Twilio body:", e)
    return twimlResponse()
  }

  if (!recordingUrl) {
    console.warn(`[call/recording] No RecordingUrl for lead ${leadId}`)
    return twimlResponse()
  }

  const fullUrl = `${recordingUrl}.mp3`
  console.log(`[call/recording] Processing ${recordingSid} for lead ${leadId}`)

  let callerPhone = ""
  let source = "Outbound"
  try {
    const sb = getLeadsClient()

    // Idempotency — bail if this SID is already attached AND the row got
    // its transcript. URL attached + message NULL means an earlier run
    // died downstream; let the replay (rescue sweep Phase B) re-run it.
    const { data: existing } = await sb
      .from("leads")
      .select("id, message")
      .eq("recording_url", fullUrl)
      .limit(1)
    if (existing && existing.length > 0) {
      if (existing[0].message) {
        console.log(`[call/recording] ${recordingSid} already processed; skipping`)
        return twimlResponse()
      }
      console.warn(`[call/recording] ${recordingSid} attached to lead ${existing[0].id} but never transcribed; re-running the pipeline`)
    }

    const { data: lead, error: lookupErr } = await sb
      .from("leads")
      .select("caller_phone, source")
      .eq("id", leadId)
      .single()
    if (lookupErr) {
      console.error("[call/recording] Lookup failed:", lookupErr)
    } else if (lead) {
      callerPhone = lead.caller_phone || ""
      source = lead.source || "Outbound"
    }

    const { error: updErr } = await sb
      .from("leads")
      .update({ recording_url: fullUrl })
      .eq("id", leadId)
    if (updErr) console.error("[call/recording] Update failed:", updErr)
    else console.log(`[call/recording] Updated lead ${leadId} with recording`)
  } catch (e) {
    console.error("[call/recording] Supabase threw:", e)
  }

  waitUntil(processRecordingBackground({
    fullUrl,
    callerPhone,
    source,
    leadId,
    direction: "outbound",
    kind: "call",
    recordingDurationSec,
  }))

  return twimlResponse()
}
