import { NextRequest, NextResponse } from "next/server"
import {
  getLeadsClient,
  sendTelegramAlert,
  analyzeCallTranscript,
  applyAnalyzeCallResult,
  fetchClusterHistory,
} from "@/lib/leads"

// Phase 7D — re-run the unified analyzer against a lead's stored transcript
// (or one POSTed in the body). Writes temperature + ai_summary + name +
// property_address + recommended_followup_date + followup_reason via the
// shared applyAnalyzeCallResult helper. Lifecycle status is NEVER touched —
// Ryan owns the dropdown.
//
// Used both manually (re-analyze button on the lead card) and as the path
// processRecordingBackground takes for every new inbound recording.

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  // `silent: true` skips the per-lead Telegram alert — used by the bulk
  // backlog re-analysis script so a 80+-row re-run doesn't spam the channel.
  let body: { transcript?: unknown; silent?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    /* empty body is fine — we'll fall back to the lead's stored transcript */
  }
  const silent = body.silent === true

  try {
    const sb = getLeadsClient()
    const { data: lead, error } = await sb
      .from("leads")
      .select("id, name, message, ai_notes, caller_phone, email")
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

    // 2026-05-11 Fix 2 — feed cluster history into the analyzer so name /
    // property / follow-up reflect the FULL conversation, not just this
    // row's message. The manual re-analyze path benefits the same as the
    // auto path in processRecordingBackground.
    const clusterHistory = await fetchClusterHistory(sb, {
      callerPhone: lead.caller_phone,
      email: lead.email,
      excludeId: id,
    })
    const result = await analyzeCallTranscript(transcript, { clusterHistory })
    if (!result) {
      return NextResponse.json({ error: "AI classification failed" }, { status: 502 })
    }

    await applyAnalyzeCallResult(id, result)

    if (!silent) {
      const recipient = lead.name || result.name || lead.caller_phone || lead.id
      await sendTelegramAlert(
        `🤖 Re-analyzed <b>${recipient}</b>: <b>${result.temperature.toUpperCase()}</b> — ${result.summary.slice(0, 200)}`
      )
    }

    return NextResponse.json({
      ok: true,
      ...result,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[analyze-call] threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
