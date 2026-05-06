import { NextRequest, NextResponse } from "next/server"
import {
  getLeadsClient,
  sendTelegramAlert,
  analyzeCallTranscript,
  applyAnalyzeCallResult,
} from "@/lib/leads"

// Phase 7C — Part 4: classify a lead from a call transcript and store
// the result in suggested_status / suggested_status_reason +
// recommended_followup_date. UI surfaces a banner with [Accept]/[Dismiss]
// (training wheels). When AUTO_STATUS=true, applies the suggestion
// directly without the banner.
//
// This route is for manual / Ryan-driven re-analysis from the lead card.
// The recording pipeline (lib/leads.ts:processRecordingBackground) calls
// the same shared helpers automatically when a transcript lands on a
// non-"new" lead — see that file for the auto-trigger path.

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  let body: { transcript?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    /* empty body is fine — we'll fall back to the lead's stored transcript */
  }

  try {
    const sb = getLeadsClient()
    const { data: lead, error } = await sb
      .from("leads")
      .select("id, name, message, ai_notes, caller_phone")
      .eq("id", id)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 })

    const transcript =
      (typeof body.transcript === "string" && body.transcript.trim()) ||
      (lead.message && lead.message.trim()) ||
      (lead.ai_notes && lead.ai_notes.trim()) ||
      null

    if (!transcript) {
      return NextResponse.json(
        { error: "no transcript available; provide one in the body or wait for the recording to transcribe" },
        { status: 400 }
      )
    }

    const result = await analyzeCallTranscript(transcript)
    if (!result) {
      return NextResponse.json({ error: "AI classification failed" }, { status: 502 })
    }

    await applyAnalyzeCallResult(id, result)

    const recipient = lead.name || lead.caller_phone || lead.id
    const verb = process.env.AUTO_STATUS === "true" ? "Auto-applied" : "Suggested"
    await sendTelegramAlert(
      `📊 ${verb} status for <b>${recipient}</b>: <b>${result.status.toUpperCase()}</b> — ${result.reason}`
    )

    return NextResponse.json({
      ok: true,
      applied: process.env.AUTO_STATUS === "true",
      ...result,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[analyze-call] threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
