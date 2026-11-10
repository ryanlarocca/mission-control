import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { computeCampaignCounts, type CampaignCounts, type Door, type PerfRow } from "@/lib/campaignPerf"
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
  drive_folder_id: string | null
  legacy: boolean                // historical mailing (Legacy tab), 2026-10-24
  order_number: string | null    // mail-house order #
  // Closed deals attributed to this campaign (Legacy tab lists them).
  closed_deals: { name: string | null; address: string | null; closed_at: string; deal_value: number | null }[]
  // Computed. Funnel (Ryan 2026-10-24): Total → Real (minus removals and
  // junk) → Leads (ever Active) → Appointment → Offer → Pending → Closed.
  // Everything below Total counts real responses only.
  total_responses: number        // every person who reached out, junk + DNC included
  total_response_rate: number | null
  removals: number               // people who asked to be removed (is_dnc)
  junk: number                   // junk / wrong person / vendor, not DNC
  responses: number              // REAL responses = total − removals − junk
  response_rate: number | null   // real responses / pieces_sent
  leads: number                  // real responses that were ever Active
  lead_rate: number | null       // leads / real responses
  appointments: number
  pending: number
  cost_per_lead: number | null
  cost_per_closed: number | null
  offers: number                 // count where offer_verbalized_at IS NOT NULL
  offer_rate: number | null      // offers / responses
  closed: number                 // count where deal_closed_at IS NOT NULL
  deal_value_total: number       // sum of deal_value where deal_closed_at IS NOT NULL
  cost_per_response: number | null
  cost_per_offer: number | null
  roi: number | null             // (deal_value_total - total_cost) / total_cost
  // Real responses by how they first reached out (2026-11-09): the letter's
  // own number / alias, the website form, the website number, other.
  by_door: Record<Door, number>
  // A/B parents only: the family counted once per person (a person who
  // answered letter A and later letter B is one response, not two).
  family: FamilyCounts | null
}

export type FamilyCounts = Omit<CampaignCounts, "closed_deals">

export async function GET() {
  try {
    const sb = getLeadsClient()
    const { data: campaigns, error: cErr } = await sb.from("campaigns").select("*")
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })

    // Every credited row, then every row of those people (offers / closes
    // usually sit on Ryan's outbound callback rows, which carry no
    // campaign_id). Paginated: PostgREST caps an unpaged select at 1,000.
    const COLS = "id, created_at, name, property_address, campaign_id, campaign_via, caller_phone, email, gmail_thread_id, twilio_number, lead_type, is_junk, is_dnc, offer_verbalized_at, offer_amount, deal_closed_at, deal_value, became_lead_at, appointment_at, pending_at"
    const PAGE = 1000
    const byId = new Map<string, PerfRow>()
    type Page = { order: (c: string, o: { ascending: boolean }) => { range: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> } }
    const pull = async (build: () => Page) => {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await build().order("id", { ascending: true }).range(from, from + PAGE - 1)
        if (error) throw new Error(error.message)
        for (const r of (data ?? []) as PerfRow[]) byId.set(r.id, r)
        if (!data || data.length < PAGE) break
      }
    }
    await pull(() => sb.from("leads").select(COLS).not("campaign_id", "is", null) as unknown as Page)
    const credited = Array.from(byId.values())
    const phones = Array.from(new Set(credited.map(r => r.caller_phone).filter((x): x is string => !!x)))
    const emails = Array.from(new Set(credited.map(r => r.email).filter((x): x is string => !!x).map(e => e.toLowerCase())))
    const threads = Array.from(new Set(credited.map(r => r.gmail_thread_id).filter((x): x is string => !!x)))
    // Separate .in() queries (an OR of IN lists dropped columns, 2026-05-17),
    // chunked so the URL stays short.
    const CHUNK = 150
    for (const [col, vals] of [["caller_phone", phones], ["email", emails], ["gmail_thread_id", threads]] as const) {
      for (let i = 0; i < vals.length; i += CHUNK) {
        const slice = vals.slice(i, i + CHUNK)
        await pull(() => sb.from("leads").select(COLS).in(col, slice) as unknown as Page)
      }
    }

    const camps = (campaigns ?? []) as (Campaign & { legacy?: boolean; order_number?: string | null })[]
    const parentOf = new Map(camps.map(c => [c.id, c.parent_campaign_id ?? c.id]))
    const familyOf = (id: string) => parentOf.get(id) ?? id
    const hasChildren = new Set(camps.filter(c => c.parent_campaign_id).map(c => c.parent_campaign_id as string))
    const { byCampaign, byFamily, offers: offerList } = computeCampaignCounts(Array.from(byId.values()), familyOf)

    const rate = (n: number, d: number | null | undefined) => (d && d > 0 ? n / d : null)
    const result: CampaignPerf[] = camps.map((c) => {
      const k = byCampaign.get(c.id) ?? emptyCounts()
      const cost = c.total_cost
      const fam = hasChildren.has(c.id) ? byFamily.get(c.id) ?? emptyCounts() : null
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
        drive_folder_id: c.drive_folder_id ?? null,
        legacy: !!c.legacy,
        order_number: c.order_number ?? null,
        closed_deals: k.closed_deals,
        total_responses: k.total_responses,
        total_response_rate: rate(k.total_responses, c.pieces_sent),
        removals: k.removals,
        junk: k.junk,
        responses: k.responses,
        response_rate: rate(k.responses, c.pieces_sent),
        leads: k.leads,
        lead_rate: k.responses > 0 ? k.leads / k.responses : null,
        appointments: k.appointments,
        pending: k.pending,
        cost_per_lead: cost != null && k.leads > 0 ? cost / k.leads : null,
        cost_per_closed: cost != null && k.closed > 0 ? cost / k.closed : null,
        offers: k.offers,
        offer_rate: k.responses > 0 ? k.offers / k.responses : null,
        closed: k.closed,
        deal_value_total: k.deal_value_total,
        cost_per_response: cost != null && k.responses > 0 ? cost / k.responses : null,
        cost_per_offer: cost != null && k.offers > 0 ? cost / k.offers : null,
        roi: cost != null && cost > 0 && k.deal_value_total > 0 ? (k.deal_value_total - cost) / cost : null,
        by_door: k.by_door,
        family: fam ? (({ closed_deals: _cd, ...rest }) => rest)(fam) : null,
      }
    })

    // Flat list of every verbalized offer (one per person), newest first,
    // with the campaign the offer counts under. Powers the Offers section.
    const nameById = new Map(camps.map(c => [c.id, c.name]))
    const offers = offerList.map(o => ({ ...o, campaign_name: o.campaign_id ? nameById.get(o.campaign_id) ?? null : null }))

    return NextResponse.json({ campaigns: result, offers })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

function emptyCounts(): CampaignCounts {
  return {
    total_responses: 0, removals: 0, junk: 0, responses: 0, leads: 0, appointments: 0, offers: 0,
    pending: 0, closed: 0, deal_value_total: 0, closed_deals: [],
    by_door: { letter: 0, website_form: 0, website_number: 0, other: 0 },
  }
}
