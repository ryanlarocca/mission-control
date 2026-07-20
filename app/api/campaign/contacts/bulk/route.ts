import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { addSuppression } from "@/lib/suppression"

// Bulk list management for campaign contacts (Ryan, 2026-07-20).
//   pause  → remove from the drip AND add to master DNC (email channel;
//            Ryan: "anybody I take off the list is added into the DNC").
//            Pending drafts cancelled. A removed agent stays reachable as
//            a future seller lead (email-channel scope, not all).
//   resume → the undo: deletes exactly the removal's DNC entry, back on
//            the drip, next touch due immediately. Other suppression
//            sources are untouched (engine re-check self-heals).
// Terminal states (suppressed / unsubscribed / bounced) are never touched.

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
        .select("id, name, email, phone")
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      const changed = data ?? []
      for (const c of changed) {
        await addSuppression(sb, {
          email: c.email,
          phone: c.phone,
          name: c.name,
          reason: "removed from campaign list (bulk)",
          source: "ryan_removed_from_campaign",
          source_ref: `campaign_contact:${c.id}:removed`,
          channel: "email",
          audience: "agent",
        })
      }
      if (changed.length > 0) {
        await sb
          .from("campaign_sends")
          .update({ status: "skipped", error: "removed from list (bulk)" })
          .in("contact_id", changed.map((c) => c.id))
          .in("status", ["draft", "approved"])
      }
      return NextResponse.json({ ok: true, changed: changed.length })
    }

    // resume
    await sb
      .from("suppression")
      .delete()
      .eq("source", "ryan_removed_from_campaign")
      .in("source_ref", ids.map((id) => `campaign_contact:${id}:removed`))
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
