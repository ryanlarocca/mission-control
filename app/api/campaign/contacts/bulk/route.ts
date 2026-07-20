import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Bulk list management for campaign contacts (Ryan, 2026-07-20: "toggle or
// remove agents from the list, efficient like the approval system").
//   pause  → remove from the drip (recoverable; pending drafts cancelled)
//   resume → back on the drip, next touch due immediately
// Terminal states (suppressed / unsubscribed / bounced) are never touched
// by bulk actions — DNC stays a deliberate per-contact act.

export async function POST(request: NextRequest) {
  let body: { ids?: unknown; action?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "json body required" }, { status: 400 })
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : []
  if (ids.length === 0 || ids.length > 500) {
    return NextResponse.json({ error: "ids must be 1..500 contact ids" }, { status: 400 })
  }
  if (body.action !== "pause" && body.action !== "resume") {
    return NextResponse.json({ error: "action must be pause or resume" }, { status: 400 })
  }

  try {
    const sb = getLeadsClient()
    const nowIso = new Date().toISOString()
    if (body.action === "pause") {
      const { data, error } = await sb
        .from("campaign_contacts")
        .update({ status: "paused", updated_at: nowIso })
        .in("id", ids)
        .in("status", ["active", "replied"])
        .select("id")
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      const changed = (data ?? []).map((r) => r.id)
      if (changed.length > 0) {
        await sb
          .from("campaign_sends")
          .update({ status: "skipped", error: "removed from list (bulk)" })
          .in("contact_id", changed)
          .in("status", ["draft", "approved"])
      }
      return NextResponse.json({ ok: true, changed: changed.length })
    }
    const { data, error } = await sb
      .from("campaign_contacts")
      .update({ status: "active", next_touch_at: nowIso, updated_at: nowIso })
      .in("id", ids)
      .eq("status", "paused")
      .select("id")
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, changed: (data ?? []).length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
