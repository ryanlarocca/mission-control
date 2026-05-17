import { getLeadsClient } from "./leads"

// Map a lead's source / source_type / created_at to a campaign_id, so the
// Campaign Performance tab can compute response/offer/closed counts per
// campaign without a fragile string match on `source`.
//
// Selection rules (see briefs/CODY_BRIEF_CAMPAIGN_PERFORMANCE_2026-05-17.md
// "Issues / Open Questions" #1):
//   1. Normalize source to a (channel, variant) signal. We accept both the
//      MFM-A / MFM-B naming and the legacy SVG-A / SVJ-B that some older
//      rows use — normalization happens at link time, not at insert time,
//      so we don't break existing data.
//   2. Find the campaign with the most recent `drop_date <= lead.created_at`
//      matching channel (and variant when known). If multiple share a drop
//      date, pick the one with the latest `created_at`.
//   3. Prefer child campaigns (with parent_campaign_id) over their parents
//      — a child A/B is always more specific than a parent rollup.
//   4. No response-window cutoff. A lead that comes in 6 months after a
//      drop still attributes to that drop — direct-mail genuinely has long
//      tails. If a 90-day window is wanted later, that's a render-time
//      filter, not a link-time one.

type SourceInput = {
  source: string | null
  source_type: string | null
  created_at?: string | Date
}

export async function resolveCampaignId(input: SourceInput): Promise<string | null> {
  const { source, source_type } = input
  if (!source && !source_type) return null

  const createdAt = input.created_at
    ? new Date(input.created_at).toISOString()
    : new Date().toISOString()

  let variant: string | null = null
  let channel: "direct_mail" | "google_ads" | null = null

  const s = (source ?? "").toUpperCase()
  if (s === "MFM-A" || s === "SVG-A") {
    variant = "pink-envelope"
    channel = "direct_mail"
  } else if (s === "MFM-B" || s === "SVJ-B") {
    variant = "white-envelope"
    channel = "direct_mail"
  } else if (s === "GOOGLE" || s === "GOOGLE ADS" || source_type === "google_ads") {
    channel = "google_ads"
  }

  if (!channel) return null

  const sb = getLeadsClient()
  let q = sb
    .from("campaigns")
    .select("id, drop_date, created_at, parent_campaign_id")
    .eq("channel", channel)
    .lte("drop_date", createdAt.slice(0, 10))
    .order("drop_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(5)

  if (variant) q = q.eq("variant", variant)

  const { data, error } = await q
  if (error || !data || data.length === 0) return null

  // Prefer child (more specific) campaign over a parent rollup.
  const child = data.find(r => r.parent_campaign_id) ?? data[0]
  return (child as { id: string }).id
}
