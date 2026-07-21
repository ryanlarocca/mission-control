import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Batch-approve campaign drafts ("Approve all on page" / "Queue N for
// send"). Only rows still in 'draft' flip — a concurrent skip or send
// isn't clobbered.

export async function POST(request: NextRequest) {
  let body: { ids?: unknown; scheduled_for?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "json body required" }, { status: 400 })
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : []
  if (ids.length === 0 || ids.length > 500) {
    return NextResponse.json({ error: "ids must be 1..500 send ids" }, { status: 400 })
  }
  // Optional "don't send before" time. Null/absent = send in the next pass.
  let scheduledFor: string | null = null
  if (typeof body.scheduled_for === "string" && body.scheduled_for.trim()) {
    const d = new Date(body.scheduled_for)
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "scheduled_for is not a valid time" }, { status: 400 })
    }
    scheduledFor = d.toISOString()
  }

  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("campaign_sends")
      .update({ status: "approved", approved_at: new Date().toISOString(), scheduled_for: scheduledFor })
      .in("id", ids)
      .eq("status", "draft")
      .select("id")
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, approved: (data ?? []).length, scheduled_for: scheduledFor })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
