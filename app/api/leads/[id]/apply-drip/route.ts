import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Phase 7C — Part 6: assign a drip campaign to a single lead.
//
// The server picks the campaign type from available contact info:
//   has phone               → direct_mail_call (phone-led, alternates email)
//   has email but no phone  → direct_mail_email (email-only)
//   has neither             → 400, nothing to drip
//
// DNC / Junk leads are rejected (the buttons are hidden in UI, but the
// endpoint guards too).
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
      .select("id, caller_phone, email, drip_campaign_type, is_dnc, is_junk, source_type")
      .eq("id", id)
      .maybeSingle()
    if (fetchErr) {
      return NextResponse.json({ error: fetchErr.message }, { status: 500 })
    }
    if (!lead) {
      return NextResponse.json({ error: "lead not found" }, { status: 404 })
    }
    if (lead.is_dnc || lead.is_junk) {
      return NextResponse.json(
        { error: "lead is flagged DNC/Junk and cannot be dripped" },
        { status: 409 }
      )
    }
    if (lead.drip_campaign_type) {
      return NextResponse.json(
        { error: `lead already on drip campaign: ${lead.drip_campaign_type}` },
        { status: 409 }
      )
    }

    const campaignType =
      lead.caller_phone
        ? "direct_mail_call"
        : lead.email
        ? "direct_mail_email"
        : null

    if (!campaignType) {
      return NextResponse.json(
        { error: "lead has no phone or email — cannot apply drip" },
        { status: 400 }
      )
    }

    const { error: updErr } = await sb
      .from("leads")
      .update({
        drip_campaign_type: campaignType,
        drip_touch_number: 0,
        last_drip_sent_at: new Date().toISOString(),
      })
      .eq("id", id)
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, campaign_type: campaignType })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
