import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// "Personal cell" toggle on the lead card.
//
// When ON, this lead is texted from Ryan's personal cell via the iMessage
// sidecar (the same path the Relationships tab uses) instead of the Twilio
// business line, and is dropped from the automated drip engine — it becomes
// an "assisted-manual" lead: it still surfaces in Follow-Ups with an AI draft,
// but nothing auto-sends. See lib/leads.ts sendLeadSms (transport branch) and
// scripts/drip-engine.js fetchEligibleLeads (the `use_personal_cell=false`
// gate).
//
// The flag is written across the whole phone cluster (every row sharing the
// lead's caller_phone), not just the clicked row — the drip engine picks ONE
// cluster row as the send driver, so flagging only one row could let a sibling
// row still get queued. sendLeadSms checks the cluster by phone too.

// Collect all lead-row ids in the cluster (same phone or email) so we can flag
// every row and sweep their queued drips. Mirrors the long-term-nurture route.
async function clusterIds(
  sb: ReturnType<typeof getLeadsClient>,
  id: string,
  phone: string | null,
  email: string | null,
): Promise<string[]> {
  const orParts: string[] = []
  if (phone) orParts.push(`caller_phone.eq.${phone}`)
  if (email) orParts.push(`email.eq.${email}`)
  if (orParts.length === 0) return [id]
  const { data } = await sb.from("leads").select("id").or(orParts.join(","))
  const ids = (data ?? []).map((r) => r.id as string)
  if (!ids.includes(id)) ids.push(id)
  return ids
}

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  try {
    const sb = getLeadsClient()
    const { data: lead, error: fetchErr } = await sb
      .from("leads")
      .select("id, caller_phone, email")
      .eq("id", id)
      .maybeSingle()
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
    if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 })
    if (!lead.caller_phone || !/\d/.test(lead.caller_phone)) {
      return NextResponse.json(
        { error: "lead has no textable phone number" },
        { status: 400 }
      )
    }

    const ids = await clusterIds(sb, id, lead.caller_phone, lead.email)

    const { error: updErr } = await sb
      .from("leads")
      .update({ use_personal_cell: true })
      .in("id", ids)
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

    // Skip any in-flight queued drips so nothing fires through Twilio after the
    // lead has been handed to the personal-cell channel. The lead still shows
    // in Follow-Ups via the live forecast; you just send it from your phone.
    const { error: dqErr } = await sb
      .from("drip_queue")
      .update({ status: "skipped", error: "switched_to_personal_cell" })
      .in("lead_id", ids)
      .in("status", ["pending", "approved"])
    if (dqErr) {
      // Non-fatal — the flag is already set, which stops future auto-sends.
      console.warn(`[personal-cell] drip_queue sweep failed for ${id}: ${dqErr.message}`)
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// DELETE clears the flag across the cluster — the lead goes back to the Twilio
// business line and re-enters the drip engine. Cadence is untouched, so it
// resumes from wherever last_drip_sent_at currently sits.
export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  try {
    const sb = getLeadsClient()
    const { data: lead, error: fetchErr } = await sb
      .from("leads")
      .select("id, caller_phone, email")
      .eq("id", id)
      .maybeSingle()
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
    if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 })

    const ids = await clusterIds(sb, id, lead.caller_phone, lead.email)
    const { error } = await sb
      .from("leads")
      .update({ use_personal_cell: false })
      .in("id", ids)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
