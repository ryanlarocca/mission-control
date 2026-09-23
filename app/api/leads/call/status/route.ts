import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, parseTwilioBody } from "@/lib/leads"

// <Dial action> callback for outbound calls placed from /api/leads/call.
// Twilio POSTs here when the lead's leg ends, with DialCallStatus =
// completed | no-answer | busy | failed | canceled and DialCallDuration.
//
// Before 2026-09-23 the bridge had no action URL, so a call the lead never
// answered left its row reading "Outbound call · awaiting recording"
// forever (Kiko Ohata, Sep 16) — nothing distinguished "no recording yet"
// from "there will never be one". An unanswered leg now stamps a short
// outcome into `message` (rendered by the timeline as an outcome line, not
// a transcript); a completed leg leaves the row alone for the recording
// callback. The rescue sweep's Phase D re-derives the same outcome from
// Twilio for any row this callback missed.
//
// Public route — Twilio webhook, listed in middleware.ts PUBLIC_PATHS.

const CALL_OUTCOME_PREFIX = "📵 "

function callOutcomeMessage(status: string): string | null {
  switch (status) {
    case "no-answer": return `${CALL_OUTCOME_PREFIX}No answer — rang out`
    case "busy": return `${CALL_OUTCOME_PREFIX}Busy`
    case "failed": return `${CALL_OUTCOME_PREFIX}Call failed — did not connect`
    case "canceled": return `${CALL_OUTCOME_PREFIX}Call canceled before it connected`
    default: return null
  }
}

const HANGUP = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup /></Response>`

export async function POST(request: NextRequest) {
  const leadId = request.nextUrl.searchParams.get("leadId")
  let status = ""
  let duration = ""
  try {
    const params = parseTwilioBody(await request.text())
    status = params.get("DialCallStatus") || ""
    duration = params.get("DialCallDuration") || ""
  } catch (e) {
    console.error("[call/status] Failed to parse Twilio body:", e)
  }
  console.log(`[call/status] lead ${leadId} → ${status || "?"} (${duration || "0"}s)`)

  const outcome = callOutcomeMessage(status)
  if (leadId && outcome) {
    try {
      const sb = getLeadsClient()
      // Only stamp a row that has nothing on it yet — never overwrite a
      // transcript that somehow already landed.
      const { error } = await sb
        .from("leads")
        .update({ message: outcome })
        .eq("id", leadId)
        .is("message", null)
        .is("recording_url", null)
      if (error) console.error("[call/status] update failed:", error.message)
    } catch (e) {
      console.error("[call/status] threw:", e)
    }
  }
  return new NextResponse(HANGUP, { headers: { "Content-Type": "text/xml" } })
}
