import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { applyStatusChange, fetchClusterRows, stampBecameLead, statusAnchor } from "@/lib/leadStatus"

// Funnel milestones on the lead card (Ryan 2026-10-24): Appointment,
// Pending (under contract), Closed + price. Offer keeps its own pencil edit
// (offer_amount via PATCH /api/leads). Written cluster-wide so every row of
// the person answers "how far did they get" — Campaign Performance and the
// segment funnel read any row.
//
// Body: { milestone: "appointment" | "pending" | "closed", date: "YYYY-MM-DD" | null, deal_value?: number | null }
// date null clears the milestone. Setting Appointment or Pending makes the
// person a lead and moves a New / Contacted / Nurture / (non-DNC) Dead card
// to Active — a tap is Ryan's own action, so it is applied even when
// automatic status is switched off.
const COLUMN = { appointment: "appointment_at", pending: "pending_at", closed: "deal_closed_at" } as const
type Milestone = keyof typeof COLUMN

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  let body: { milestone?: unknown; date?: unknown; deal_value?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const milestone = body.milestone as Milestone
  if (!(milestone in COLUMN)) return NextResponse.json({ error: "milestone must be appointment | pending | closed" }, { status: 400 })
  const date = body.date
  if (date !== null && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD or null" }, { status: 400 })
  }
  let dealValue: number | null | undefined
  if (milestone === "closed" && body.deal_value !== undefined) {
    if (body.deal_value === null) dealValue = null
    else if (typeof body.deal_value === "number" && Number.isFinite(body.deal_value) && body.deal_value > 0) dealValue = body.deal_value
    else return NextResponse.json({ error: "deal_value must be a positive number or null" }, { status: 400 })
  }

  try {
    const sb = getLeadsClient()
    const { data: row, error } = await sb.from("leads").select("id, caller_phone, email, gmail_thread_id").eq("id", params.id).maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!row) return NextResponse.json({ error: "lead not found" }, { status: 404 })
    const rows = await fetchClusterRows(sb, row)
    const ids = rows.map((r) => r.id)

    // Noon UTC keeps the calendar date stable in Pacific time.
    const update: Record<string, unknown> = { [COLUMN[milestone]]: date ? `${date}T12:00:00Z` : null }
    if (milestone === "closed") {
      if (date === null) update.deal_value = null
      else if (dealValue !== undefined) update.deal_value = dealValue
    }
    const { error: upErr } = await sb.from("leads").update(update).in("id", ids)
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

    if (date) {
      await stampBecameLead(sb, rows)
      const anchor = statusAnchor(rows)
      const dnc = rows.some((r) => r.is_dnc)
      if (anchor && !dnc && milestone !== "closed" && anchor.status !== "active") {
        await applyStatusChange(sb, { rows, anchor, to: "active", source: "milestone", reason: `${milestone} set ${date}` })
      }
    }
    return NextResponse.json({ ok: true, milestone, date, ids })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
