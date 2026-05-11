import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, normalizePhone } from "@/lib/leads"

// Cheap yes/no check the Follow-Up tab's "Done" button uses to decide
// whether a click-to-call recently fired against this lead. If yes, the
// upcoming analyzeCallTranscript pass will set the next follow-up date,
// so we clear the current recommendation silently. If no, Done opens the
// inline interval picker.
//
// Body: { phone, windowMinutes? } → { hasRecent: boolean }
export async function POST(request: NextRequest) {
  let body: { phone?: unknown; windowMinutes?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (typeof body.phone !== "string" || !body.phone) {
    return NextResponse.json({ error: "phone required" }, { status: 400 })
  }
  const phone = normalizePhone(body.phone)
  const windowMin =
    typeof body.windowMinutes === "number" && body.windowMinutes > 0
      ? Math.min(body.windowMinutes, 24 * 60)
      : 60
  const since = new Date(Date.now() - windowMin * 60_000).toISOString()
  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("leads")
      .select("id")
      .eq("caller_phone", phone)
      .in("lead_type", ["call", "voicemail"])
      .gte("created_at", since)
      .limit(1)
    if (error) {
      console.error("[recent-call-check] query failed:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ hasRecent: (data || []).length > 0 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[recent-call-check] threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
