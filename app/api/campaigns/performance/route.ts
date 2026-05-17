import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import type { Campaign } from "../route"

// Per-campaign funnel + ROI rollup. One row per campaign (parent + children
// both surface, the tab UI handles grouping). Counts are NULL-safe — when a
// metric isn't computable (e.g. response_rate for a google_ads campaign
// without a `pieces_sent` divisor), we return null and the UI shows "—".
//
// Force-dynamic for the same reason /api/drips needed it — the GET reads
// no per-request input, so Next.js would happily edge-cache the response.
export const dynamic = "force-dynamic"

export interface CampaignPerf {
  id: string
  name: string
  channel: "direct_mail" | "google_ads"
  drop_date: string | null
  pieces_sent: number | null
  total_cost: number | null
  variant: string | null
  parent_campaign_id: string | null
  notes: string | null
  // Computed:
  responses: number              // count of non-junk leads with campaign_id = id
  response_rate: number | null   // responses / pieces_sent
  offers: number                 // count where offer_verbalized_at IS NOT NULL
  offer_rate: number | null      // offers / responses
  closed: number                 // count where deal_closed_at IS NOT NULL
  deal_value_total: number       // sum of deal_value where deal_closed_at IS NOT NULL
  cost_per_response: number | null
  cost_per_offer: number | null
  roi: number | null             // (deal_value_total - total_cost) / total_cost
}

export async function GET() {
  try {
    const sb = getLeadsClient()
    const [{ data: campaigns, error: cErr }, { data: leads, error: lErr }] = await Promise.all([
      sb.from("campaigns").select("*"),
      sb
        .from("leads")
        .select("campaign_id, is_junk, offer_verbalized_at, deal_closed_at, deal_value")
        .not("campaign_id", "is", null),
    ])
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
    if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })

    // Bucket the lead rows by campaign_id for O(N) rollup.
    type LeadRow = {
      campaign_id: string
      is_junk: boolean | null
      offer_verbalized_at: string | null
      deal_closed_at: string | null
      deal_value: number | null
    }
    const byCampaign = new Map<string, LeadRow[]>()
    for (const l of (leads ?? []) as LeadRow[]) {
      const cid = l.campaign_id
      if (!byCampaign.has(cid)) byCampaign.set(cid, [])
      byCampaign.get(cid)!.push(l)
    }

    const result: CampaignPerf[] = ((campaigns ?? []) as Campaign[]).map((c) => {
      const ls = byCampaign.get(c.id) ?? []
      // Junked leads aren't real responses — exclude from the funnel.
      const real = ls.filter((l) => !l.is_junk)
      const responses = real.length
      const offers = real.filter((l) => l.offer_verbalized_at != null).length
      const closed = real.filter((l) => l.deal_closed_at != null).length
      const dealValueTotal = real
        .filter((l) => l.deal_closed_at != null && typeof l.deal_value === "number")
        .reduce((acc, l) => acc + (l.deal_value ?? 0), 0)

      const responseRate = c.pieces_sent && c.pieces_sent > 0
        ? responses / c.pieces_sent
        : null
      const offerRate = responses > 0 ? offers / responses : null
      const costPerResponse = c.total_cost != null && responses > 0
        ? c.total_cost / responses
        : null
      const costPerOffer = c.total_cost != null && offers > 0
        ? c.total_cost / offers
        : null
      const roi = c.total_cost != null && c.total_cost > 0 && dealValueTotal > 0
        ? (dealValueTotal - c.total_cost) / c.total_cost
        : null

      return {
        id: c.id,
        name: c.name,
        channel: c.channel,
        drop_date: c.drop_date,
        pieces_sent: c.pieces_sent,
        total_cost: c.total_cost,
        variant: c.variant,
        parent_campaign_id: c.parent_campaign_id,
        notes: c.notes,
        responses,
        response_rate: responseRate,
        offers,
        offer_rate: offerRate,
        closed,
        deal_value_total: dealValueTotal,
        cost_per_response: costPerResponse,
        cost_per_offer: costPerOffer,
        roi,
      }
    })

    return NextResponse.json({ campaigns: result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
