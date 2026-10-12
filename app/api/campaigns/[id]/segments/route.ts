import { NextRequest, NextResponse } from "next/server"
import { clusterKey, getLeadsClient } from "@/lib/leads"

// Segment report for a direct-mail campaign: pieces mailed and distinct
// responders per list segment (arm, county, batch, tags, signals), from the
// mail_segment_stats() SQL function, plus the unmatched / in-list-not-mailed
// responder counts so the denominator caveat is visible on the panel.
//
// A/B piece children (campaigns.parent_campaign_id + campaigns.piece, NOO Q4
// 2026 — A / — B, 2026-10-12) own no mail_records: the one list is on the
// parent. For a child we run mail_segment_stats_piece(parent, piece) — the
// same report restricted to the rows mailed that creative — so every
// dimension (and the `piece` dimension itself) is the child's slice. Leads
// are still counted against the child (that's where attribution lands).
// Parent behaviour is unchanged.
export const dynamic = "force-dynamic"

interface StatRow { dimension: string; segment: string; pieces: number; responders: number }
export interface SegmentRow { segment: string; pieces: number; responders: number; per_thousand: number; cost_per_response: number | null }

const PAGE = 1000

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const sb = getLeadsClient()
  try {
    const { data: campaign, error: cErr } = await sb
      .from("campaigns")
      .select("id, pieces_sent, total_cost, parent_campaign_id, piece")
      .eq("id", params.id)
      .maybeSingle()
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
    if (!campaign) return NextResponse.json({ error: "campaign not found" }, { status: 404 })

    // Records live on the parent for an A/B piece child.
    const childPiece = campaign.parent_campaign_id && campaign.piece ? String(campaign.piece) : null
    const recordsCampaignId = (campaign.parent_campaign_id as string | null) ?? params.id

    let recordsQuery = sb
      .from("mail_records")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", recordsCampaignId)
    if (childPiece) recordsQuery = recordsQuery.eq("piece", childPiece)
    const { count: recordCount } = await recordsQuery
    if (!recordCount) {
      return NextResponse.json({
        has_mail_records: false, pieces: 0, responders_matched: 0, responders_unmatched: 0,
        responders_in_list_not_mailed: 0, unit_cost: null, dimensions: {},
      })
    }

    const { data: stats, error: sErr } = childPiece
      ? await sb.rpc("mail_segment_stats_piece", { p_campaign: recordsCampaignId, p_piece: childPiece })
      : await sb.rpc("mail_segment_stats", { p_campaign: recordsCampaignId })
    if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })
    const rows = (stats ?? []) as StatRow[]
    const pieces = rows.filter(r => r.dimension === "arm").reduce((a, r) => a + Number(r.pieces), 0)
    const respondersMatched = rows.filter(r => r.dimension === "arm").reduce((a, r) => a + Number(r.responders), 0)
    let unitCost =
      campaign.total_cost != null && campaign.pieces_sent ? Number(campaign.total_cost) / Number(campaign.pieces_sent) : null
    if (unitCost == null && campaign.parent_campaign_id) {
      // A child usually carries no cost of its own — one print run, one
      // invoice on the parent. Same letter, same unit cost.
      const { data: parent } = await sb
        .from("campaigns")
        .select("pieces_sent, total_cost")
        .eq("id", campaign.parent_campaign_id)
        .maybeSingle()
      if (parent && parent.total_cost != null && parent.pieces_sent) unitCost = Number(parent.total_cost) / Number(parent.pieces_sent)
    }

    const dimensions: Record<string, SegmentRow[]> = {}
    for (const r of rows) {
      const p = Number(r.pieces), n = Number(r.responders)
      ;(dimensions[r.dimension] ??= []).push({
        segment: r.segment,
        pieces: p,
        responders: n,
        per_thousand: p ? Math.round((n / p) * 1000 * 100) / 100 : 0,
        cost_per_response: unitCost != null && n ? Math.round(((p * unitCost) / n) * 100) / 100 : null,
      })
    }

    // Unmatched responders: non-junk lead clusters attributed to this campaign with no record link.
    const unmatched = new Set<string>()
    const inListNotMailed = new Set<string>()
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from("leads")
        .select("id, caller_phone, email, gmail_thread_id, is_junk, mail_record_id, mail_records(arm)")
        .eq("campaign_id", params.id)
        .range(from, from + PAGE - 1)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      for (const l of data ?? []) {
        if (l.is_junk) continue
        const key = clusterKey(l) ?? `id:${l.id}`
        if (!l.mail_record_id) unmatched.add(key)
        else {
          const rec = l.mail_records as unknown as { arm: string } | { arm: string }[] | null
          const arm = Array.isArray(rec) ? rec[0]?.arm : rec?.arm
          if (arm === "none") inListNotMailed.add(l.mail_record_id)
        }
      }
      if (!data || data.length < PAGE) break
    }

    return NextResponse.json({
      has_mail_records: true,
      pieces,
      responders_matched: respondersMatched,
      responders_unmatched: unmatched.size,
      responders_in_list_not_mailed: inListNotMailed.size,
      unit_cost: unitCost,
      dimensions,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
