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
    // Pull attributed leads (campaign_id set) AND every cluster sibling
    // so the funnel can resolve offer/close events that landed on the
    // outbound-call row (no campaign_id) of an attributed cluster.
    // Without this, Brian Metcalf's $1.8M offer on his Outbound row
    // doesn't show up under MFM-B even though his cluster IS attributed
    // to MFM-B — that's the common case (Ryan verbalizes offers on
    // callbacks, attribution lives on the original inbound voicemail).
    const [{ data: campaigns, error: cErr }, { data: attributedRaw, error: lErr }] = await Promise.all([
      sb.from("campaigns").select("*"),
      sb
        .from("leads")
        .select("id, campaign_id, caller_phone, email, gmail_thread_id, is_junk, offer_verbalized_at, deal_closed_at, deal_value")
        .not("campaign_id", "is", null),
    ])
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
    if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })

    type AttrRow = {
      id: string
      campaign_id: string
      caller_phone: string | null
      email: string | null
      gmail_thread_id: string | null
      is_junk: boolean | null
      offer_verbalized_at: string | null
      deal_closed_at: string | null
      deal_value: number | null
    }
    const attributed = (attributedRaw ?? []) as AttrRow[]

    // Second query: every lead row in a cluster that contains at least
    // one attributed row, so we can hoist offers/closes from siblings.
    const phones = Array.from(new Set(attributed.map(r => r.caller_phone).filter((x): x is string => !!x)))
    const emails = Array.from(new Set(attributed.map(r => r.email).filter((x): x is string => !!x).map(e => e.toLowerCase())))
    const threads = Array.from(new Set(attributed.map(r => r.gmail_thread_id).filter((x): x is string => !!x)))
    const orParts: string[] = []
    if (phones.length > 0) orParts.push(`caller_phone.in.(${phones.map(p => `"${p}"`).join(",")})`)
    if (emails.length > 0) orParts.push(`email.in.(${emails.map(e => `"${e}"`).join(",")})`)
    if (threads.length > 0) orParts.push(`gmail_thread_id.in.(${threads.map(t => `"${t}"`).join(",")})`)
    type SibRow = {
      caller_phone: string | null
      email: string | null
      gmail_thread_id: string | null
      offer_verbalized_at: string | null
      deal_closed_at: string | null
      deal_value: number | null
    }
    let siblings: SibRow[] = []
    if (orParts.length > 0) {
      const { data: sib, error: sErr } = await sb
        .from("leads")
        .select("caller_phone, email, gmail_thread_id, offer_verbalized_at, deal_closed_at, deal_value")
        .or(orParts.join(","))
      if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })
      siblings = (sib ?? []) as SibRow[]
    }

    const clusterKey = (r: { caller_phone: string | null; email: string | null; gmail_thread_id: string | null }): string | null => {
      if (r.caller_phone) return `phone:${r.caller_phone}`
      if (r.gmail_thread_id) return `thread:${r.gmail_thread_id}`
      if (r.email) return `email:${r.email.toLowerCase()}`
      return null
    }
    // Cluster-level event signals — does ANY row in this cluster have an
    // offer / a close? Use Set/Map for O(1) lookup during the rollup.
    const clusterOfferAt = new Map<string, string>() // earliest offer timestamp per cluster
    const clusterClose = new Map<string, { count: number; deal_value: number }>()
    for (const s of siblings) {
      const k = clusterKey(s)
      if (!k) continue
      if (s.offer_verbalized_at && !clusterOfferAt.has(k)) clusterOfferAt.set(k, s.offer_verbalized_at)
      if (s.deal_closed_at) {
        const cur = clusterClose.get(k) ?? { count: 0, deal_value: 0 }
        clusterClose.set(k, { count: cur.count + 1, deal_value: cur.deal_value + (s.deal_value ?? 0) })
      }
    }

    // Bucket attributed rows by campaign, deduping to one cluster per
    // campaign so a 3-row cluster doesn't count as 3 responses.
    const byCampaign = new Map<string, AttrRow[]>()
    for (const r of attributed) {
      if (!byCampaign.has(r.campaign_id)) byCampaign.set(r.campaign_id, [])
      byCampaign.get(r.campaign_id)!.push(r)
    }

    const result: CampaignPerf[] = ((campaigns ?? []) as Campaign[]).map((c) => {
      const rows = byCampaign.get(c.id) ?? []
      // Dedupe by cluster key — same caller appearing on multiple
      // attributed rows is one response, not many.
      const seen = new Set<string>()
      const clusters: AttrRow[] = []
      for (const r of rows) {
        const k = clusterKey(r) ?? `id:${r.id}`
        if (seen.has(k)) continue
        seen.add(k)
        clusters.push(r)
      }
      // Junked leads aren't real responses — exclude from the funnel.
      // is_junk is per-row; check the canonical row's flag. If any non-
      // junk attributed row exists, the cluster counts as a real response.
      const real = clusters.filter((r) => {
        if (!r.is_junk) return true
        const k = clusterKey(r) ?? `id:${r.id}`
        // If another row in the cluster isn't junked, keep it.
        return rows.some(other => (clusterKey(other) ?? `id:${other.id}`) === k && !other.is_junk)
      })
      const responses = real.length
      // Offers / closes: count clusters where the cluster has the event,
      // not rows. This is the fix for Brian Metcalf's $1.8M landing on
      // his Outbound row (which has no campaign_id) — the cluster IS
      // attributed to MFM-B via his other rows, so the offer counts.
      const offers = real.filter(r => {
        const k = clusterKey(r) ?? `id:${r.id}`
        return clusterOfferAt.has(k)
      }).length
      const closed = real.filter(r => {
        const k = clusterKey(r) ?? `id:${r.id}`
        return clusterClose.has(k)
      }).length
      const dealValueTotal = real.reduce((acc, r) => {
        const k = clusterKey(r) ?? `id:${r.id}`
        return acc + (clusterClose.get(k)?.deal_value ?? 0)
      }, 0)

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

    return NextResponse.json({
      campaigns: result,
      _debug: {
        attributed: attributed.length,
        phones: phones.length,
        emails: emails.length,
        threads: threads.length,
        siblings: siblings.length,
        clusterOfferAt: clusterOfferAt.size,
        offerKeys: Array.from(clusterOfferAt.keys()),
        candaceSibling: siblings.find(s => s.caller_phone === "+16509067148" && s.offer_verbalized_at) ?? null,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
