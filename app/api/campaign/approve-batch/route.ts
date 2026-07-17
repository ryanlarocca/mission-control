import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Batch-approve campaign drafts ("Approve all on page" / "Queue N for
// send"). Only rows still in 'draft' flip — a concurrent skip or send
// isn't clobbered.

export async function POST(request: NextRequest) {
  let body: { ids?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "json body required" }, { status: 400 })
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : []
  if (ids.length === 0 || ids.length > 500) {
    return NextResponse.json({ error: "ids must be 1..500 send ids" }, { status: 400 })
  }

  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("campaign_sends")
      .update({ status: "approved", approved_at: new Date().toISOString() })
      .in("id", ids)
      .eq("status", "draft")
      .select("id")
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, approved: (data ?? []).length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
