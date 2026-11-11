import { NextRequest, NextResponse } from "next/server"
import { startLeadCall } from "@/lib/leadCall"

// Click "Call" on a lead card — rings Ryan's cell, then bridges to the lead
// from the line they know. The relay itself lives in lib/leadCall.ts so the
// Telegram website-lead alert's 📞 Call button places the identical call.

export async function POST(request: NextRequest) {
  let body: { phone?: string; source?: string | null } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const out = await startLeadCall(body)
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status })
  return NextResponse.json({ success: true, callSid: out.callSid, leadId: out.leadId, from: out.from, callerId: out.callerId, dialed: out.dialed })
}
