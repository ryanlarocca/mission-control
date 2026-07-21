import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Email-drip campaign approval queue (Phase 3 of
// briefs/EMAIL_DRIP_CAMPAIGN_2026-07-17.md). Drafts are created by
// scripts/campaign-engine.mjs on the Mac mini; this route feeds the
// /email-campaign review UI. Approving here is the send authorization —
// the engine's next pass sends approved rows inside the 9:00–4:30 window.

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status") ?? "pending"
  try {
    const sb = getLeadsClient()

    let q = sb
      .from("campaign_sends")
      .select(
        "id, touch_number, subject, body, status, edited, approved_at, scheduled_for, sent_at, error, created_at, contact:campaign_contacts (id, name, email, import_flags, property_address)"
      )
      .order("created_at", { ascending: true })
      .limit(500)
    if (status === "pending") q = q.in("status", ["draft", "approved"])
    else if (status !== "all") q = q.eq("status", status)

    const { data: sends, error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)

    const [draft, approved, sentToday, failed, active, due] = await Promise.all([
      sb.from("campaign_sends").select("id", { count: "exact", head: true }).eq("status", "draft"),
      sb.from("campaign_sends").select("id", { count: "exact", head: true }).eq("status", "approved"),
      sb.from("campaign_sends").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", startOfDay.toISOString()),
      sb.from("campaign_sends").select("id", { count: "exact", head: true }).eq("status", "failed"),
      sb.from("campaign_contacts").select("id", { count: "exact", head: true }).eq("status", "active"),
      sb.from("campaign_contacts").select("id", { count: "exact", head: true }).eq("status", "active").lte("next_touch_at", new Date().toISOString()),
    ])

    return NextResponse.json({
      sends: sends ?? [],
      counts: {
        draft: draft.count ?? 0,
        approved: approved.count ?? 0,
        sent_today: sentToday.count ?? 0,
        failed: failed.count ?? 0,
        active_contacts: active.count ?? 0,
        due_contacts: due.count ?? 0,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
