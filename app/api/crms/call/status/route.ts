import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, parseTwilioBody } from "@/lib/leads"
import { callOutcomeMessage } from "@/lib/relationship-calls"

// <Dial action> for Relationships calls: fires when the contact's leg ends
// with DialCallStatus = completed | no-answer | busy | failed | canceled.
// A completed leg is a real touch → bump last_contacted_at here (the
// recording pipeline fills the summary later). Anything else stamps an
// outcome line so the card never shows a call that "never happened".
// Public route — Twilio webhook, listed in middleware.ts PUBLIC_PATHS.

const HANGUP = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup /></Response>`

export async function POST(request: NextRequest) {
  const touchId = request.nextUrl.searchParams.get("touchId")
  const leg = request.nextUrl.searchParams.get("leg")
  let status = ""
  let duration: number | null = null
  try {
    const params = parseTwilioBody(await request.text())
    if (leg === "ryan") {
      // First-leg StatusCallback (Ryan's cell). Only act when the leg ended
      // without ever connecting — a completed first leg means the bridge
      // ran and the <Dial action> below owns the outcome.
      const s = params.get("CallStatus") || ""
      if (touchId && ["no-answer", "busy", "failed", "canceled"].includes(s)) {
        await getLeadsClient()
          .from("relationship_touches")
          .update({ call_status: s, message: "📵 Your cell didn't pick up — contact was never dialed" })
          .eq("id", touchId)
          .eq("call_status", "dialing")
      }
      return new NextResponse(HANGUP, { headers: { "Content-Type": "text/xml" } })
    }
    status = params.get("DialCallStatus") || ""
    const d = Number(params.get("DialCallDuration") || "")
    duration = Number.isFinite(d) ? d : null
  } catch (e) {
    console.error("[crms/call/status] parse failed:", e)
  }
  console.log(`[crms/call/status] touch ${touchId} → ${status || "?"} (${duration ?? 0}s)`)
  if (touchId && status) {
    try {
      const sb = getLeadsClient()
      const outcome = callOutcomeMessage(status)
      const { data: t } = await sb
        .from("relationship_touches")
        .update({ call_status: status, call_duration_sec: duration, ...(outcome ? { message: outcome } : {}) })
        .eq("id", touchId)
        .is("transcript", null)
        .select("relationship_id")
        .single()
      if (status === "completed" && t?.relationship_id) {
        const { error } = await sb
          .from("relationships")
          .update({ last_contacted_at: new Date().toISOString() })
          .eq("id", t.relationship_id)
        if (error) console.error("[crms/call/status] last_contacted_at failed:", error.message)
      }
    } catch (e) {
      console.error("[crms/call/status] threw:", e)
    }
  }
  return new NextResponse(HANGUP, { headers: { "Content-Type": "text/xml" } })
}
