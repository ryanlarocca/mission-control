import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { normalizeDialE164, startOfficeRelayCall } from "@/lib/officeCall"

// Relationships-tab click-to-call. Mirrors /api/leads/call but the record is a
// `relationship_touches` row (modality='call') instead of a lead. The call
// itself — touch insert, ringing Ryan's cell, the bridge to the contact — is
// lib/officeCall.startOfficeRelayCall (2026-11-11), shared with "call him" in
// Telegram; this route keeps the body validation and the response shape.
// GET ?touchId= lets the card poll the outcome while the call is in flight.
// Card # ON (relationships.use_card_line, 2026-10-26): the contact sees the
// business-card line instead — see lib/officeCall.

export async function POST(request: NextRequest) {
  let body: { id?: string; phone?: string; tier?: string; category?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const relationshipId = body.id
  const to = body.phone ? normalizeDialE164(body.phone) : null
  if (!relationshipId || !to) {
    return NextResponse.json({ error: "id and a valid phone are required" }, { status: 400 })
  }
  const out = await startOfficeRelayCall({ relationshipId, phone: to, tier: body.tier ?? null, category: body.category ?? null })
  if (!out.ok) return NextResponse.json({ error: out.error ?? "call failed" }, { status: out.status ?? 500 })
  return NextResponse.json({ success: true, touchId: out.touchId, callSid: out.callSid ?? null, callerId: out.callerId })
}

export async function GET(request: NextRequest) {
  const touchId = request.nextUrl.searchParams.get("touchId")
  if (!touchId) return NextResponse.json({ error: "touchId required" }, { status: 400 })
  const { data, error } = await getLeadsClient()
    .from("relationship_touches")
    .select("call_status, call_duration_sec, message, recording_url, transcript")
    .eq("id", touchId)
    .single()
  if (error || !data) return NextResponse.json({ error: error?.message || "not found" }, { status: 404 })
  return NextResponse.json({
    status: data.call_status,
    durationSec: data.call_duration_sec,
    summary: data.transcript ? data.message : null,
    outcome: !data.transcript ? data.message : null,
    hasRecording: !!data.recording_url,
  })
}
