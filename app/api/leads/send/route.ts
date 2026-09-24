import { NextRequest, NextResponse } from "next/server"
import { sendLeadSms } from "@/lib/leads"
import { markDraftSent } from "@/lib/reply/record"

// Outbound message endpoint for the Leads + Follow Ups tabs. Thin wrapper over
// lib/leads `sendLeadSms`, which owns the actual send + logging so the same
// behavior is shared with the Telegram reply webhook
// (/api/telegram/webhook). It sends via the Twilio Messaging API from the
// line the lead contacted (resolveReplyLine, 2026-09-22; previously always
// the outbound caller-ID number +16502043247) so leads see ONE number for both
// calls and texts, logs the outbound message with twilio_number=null (the
// outbound marker), auto-detects offers, promotes the intake row
// new→contacted, and resets the drip cadence clock.
//
// 2026-05-21 — migrated off the Mac-mini sidecar (iMessage w/ SMS fallback).
// Twilio's A2P 10DLC campaign was approved and +16502043247 attached to it,
// so app-initiated SMS is compliant.

export async function POST(request: NextRequest) {
  let body: { phone?: string; message?: string; source?: string | null; draftId?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const result = await sendLeadSms({
    phone: body.phone ?? "",
    message: body.message ?? "",
    source: body.source ?? null,
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  // Reply Planner: link the send to the draft it came from.
  if (typeof body.draftId === "string" && body.draftId.trim()) {
    await markDraftSent(body.draftId.trim(), { subject: null, body: body.message ?? "" })
  }

  return NextResponse.json({
    success: true,
    service: "twilio_sms",
    messageSid: result.messageSid,
    leadId: result.leadId,
    logError: result.logError,
  })
}
