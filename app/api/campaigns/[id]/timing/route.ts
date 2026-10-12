import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import type { TimingBatch } from "@/lib/mailTiming"

// Response timing for a direct-mail campaign: per batch, how many days after
// arrival (coalesce(arrived_at, drop_date)) the first non-junk inbound lead
// landed — p25 / median / p75 plus a weekly histogram — from the
// mail_response_timing() SQL function (2026-10-12_mail_response_timing.sql).
//
// Mirrors GET /api/campaigns/[id]/segments: an A/B piece child
// (campaigns.parent_campaign_id + campaigns.piece) owns no mail_records, so
// for a child we run mail_response_timing_piece(parent, piece) against the
// parent's records restricted to that creative. Parent behaviour is
// unchanged.
export const dynamic = "force-dynamic"

interface TimingRow {
  batch: number | null
  pieces: number | string
  responders: number | string
  median_days: number | string | null
  p25_days: number | string | null
  p75_days: number | string | null
  weekly: Record<string, number> | null
}

export interface TimingPayload { has_mail_records: boolean; batches: TimingBatch[] }

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const sb = getLeadsClient()
  try {
    const { data: campaign, error: cErr } = await sb
      .from("campaigns")
      .select("id, parent_campaign_id, piece")
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
      return NextResponse.json({ has_mail_records: false, batches: [] } satisfies TimingPayload)
    }

    const { data: rows, error: tErr } = childPiece
      ? await sb.rpc("mail_response_timing_piece", { p_campaign: recordsCampaignId, p_piece: childPiece })
      : await sb.rpc("mail_response_timing", { p_campaign: recordsCampaignId })
    if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })

    // bigint / numeric come back as strings through PostgREST — normalise.
    const batches: TimingBatch[] = ((rows ?? []) as TimingRow[]).map(r => ({
      batch: r.batch == null ? null : Number(r.batch),
      pieces: num(r.pieces) ?? 0,
      responders: num(r.responders) ?? 0,
      median_days: num(r.median_days),
      p25_days: num(r.p25_days),
      p75_days: num(r.p75_days),
      weekly: r.weekly ?? {},
    }))

    return NextResponse.json({ has_mail_records: true, batches } satisfies TimingPayload)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
