import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { getCampaign, getNextTouch, type DripCampaignType } from "@/lib/drip-campaigns"

// Skip a forecast touch without sending: advance the lead's
// drip_touch_number to the next touch + stamp last_drip_sent_at=now so the
// engine moves past it on the next pass.
//
// Body: { leadId }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  let body: { leadId?: unknown } = {}
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  const leadId = typeof body.leadId === "string" ? body.leadId : null
  if (!leadId || !UUID_RE.test(leadId)) return NextResponse.json({ error: "leadId must be a UUID" }, { status: 400 })

  try {
    const sb = getLeadsClient()
    const { data: lead, error } = await sb
      .from("leads")
      .select("id, drip_campaign_type, drip_touch_number")
      .eq("id", leadId)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 })
    if (!lead.drip_campaign_type) return NextResponse.json({ error: "lead has no drip campaign" }, { status: 409 })

    const campaign = getCampaign(lead.drip_campaign_type as DripCampaignType)
    if (!campaign) return NextResponse.json({ error: `unknown campaign ${lead.drip_campaign_type}` }, { status: 500 })
    const next = getNextTouch(campaign, lead.drip_touch_number ?? 0)
    if (!next) return NextResponse.json({ error: "no more touches in cadence" }, { status: 409 })

    const { error: upErr } = await sb
      .from("leads")
      .update({ drip_touch_number: next.touchNumber, last_drip_sent_at: new Date().toISOString() })
      .eq("id", leadId)
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

    return NextResponse.json({ ok: true, skippedTouch: next.touchNumber })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
