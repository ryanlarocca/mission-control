import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, haltOutreachForCluster } from "@/lib/leads"

// "Move to long-term nurture" — the right move for a lead who explicitly
// said "not now, maybe in a year or two" (Kiko Ohata 2026-05-17 was the
// canonical case). Switches the lead off whatever aggressive cadence
// they're on, onto the slow `long_term_nurture` campaign (60/120/180/
// 240/365/540 days, alternating email + iMessage), and stamps a 6-month
// follow-up callback so it surfaces in the Follow-Ups tab for Ryan to
// review even if they go fully dark.
//
// What this does, in order:
//   1. Skip cluster's pending/approved drips (haltOutreachForCluster) —
//      otherwise the existing direct_mail_call queue would still fire.
//   2. Stamp drip_campaign_type=long_term_nurture, reset touch counter,
//      pin last_drip_sent_at to now() so the first soft touch is 60 days
//      out (not immediate).
//   3. Set recommended_followup_date to now + 6 months. Clears any sooner
//      followups on cluster siblings (auto-supersession — newest wins).
//
// Idempotent-ish: re-applying simply re-stamps the campaign and pushes
// the cadence clock forward, which is the expected reset behavior.

const SIX_MONTHS_DAYS = 180

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
      .select("id, caller_phone, email, is_dnc, is_junk")
      .eq("id", id)
      .maybeSingle()
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
    if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 })
    if (lead.is_dnc || lead.is_junk) {
      return NextResponse.json(
        { error: "lead is flagged DNC/Junk — clear the flag before applying nurture" },
        { status: 409 }
      )
    }
    if (!lead.caller_phone && !lead.email) {
      return NextResponse.json(
        { error: "lead has no phone or email — nurture has nothing to send through" },
        { status: 400 }
      )
    }

    // 1. Sweep in-flight outreach. is_junk/is_dnc are false here so
    // haltOutreachForCluster will use the "lead_marked_junk" reason
    // string — write a more accurate one ourselves first.
    try {
      const orParts: string[] = []
      if (lead.caller_phone) orParts.push(`caller_phone.eq.${lead.caller_phone}`)
      if (lead.email) orParts.push(`email.eq.${lead.email}`)
      let clusterIds: string[]
      if (orParts.length > 0) {
        const { data: siblings } = await sb.from("leads").select("id").or(orParts.join(","))
        clusterIds = (siblings ?? []).map(r => r.id as string)
        if (!clusterIds.includes(id)) clusterIds.push(id)
      } else {
        clusterIds = [id]
      }
      await sb
        .from("drip_queue")
        .update({ status: "skipped", error: "switched_to_long_term_nurture" })
        .in("lead_id", clusterIds)
        .in("status", ["pending", "approved"])

      // 3a. Auto-supersession: clear any existing followup on cluster siblings
      // BEFORE writing the new one on this row.
      const sibsToClear = clusterIds.filter(cid => cid !== id)
      if (sibsToClear.length > 0) {
        await sb
          .from("leads")
          .update({ recommended_followup_date: null, followup_reason: null })
          .in("id", sibsToClear)
          .not("recommended_followup_date", "is", null)
      }
    } catch (sweepErr) {
      console.warn(`[ltn] cluster sweep failed for ${id}:`, sweepErr instanceof Error ? sweepErr.message : String(sweepErr))
    }

    // 2 + 3b. Stamp the campaign + the 6-month follow-up on this row.
    const now = new Date()
    const followupDate = new Date(now.getTime() + SIX_MONTHS_DAYS * 86400 * 1000)
      .toISOString().slice(0, 10)
    const { error: updErr } = await sb
      .from("leads")
      .update({
        drip_campaign_type: "long_term_nurture",
        drip_touch_number: 0,
        last_drip_sent_at: now.toISOString(),
        recommended_followup_date: followupDate,
        followup_reason: "Long-term nurture — re-engage in ~6 months.",
        followup_generated_at: now.toISOString(),
      })
      .eq("id", id)
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

    return NextResponse.json({
      ok: true,
      campaign_type: "long_term_nurture",
      recommended_followup_date: followupDate,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[ltn] threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
