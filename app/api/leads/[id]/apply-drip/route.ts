import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { pickCampaignType } from "@/lib/drip-campaigns"

// Phase 7C — Part 6: assign a drip campaign to a single lead.
//
// Campaign selection is source-aware: Google Ads form leads route to the
// google_ads_* campaigns (touch #1+ AI-drafted, no "missed call" opener);
// direct mail intake stays on direct_mail_*; anything else falls through
// the legacy phone-led default.
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
      .select("id, caller_phone, email, drip_campaign_type, is_dnc, is_junk, source_type, source")
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

    const campaignType = pickCampaignType(lead)

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
