import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Phase 7C — Part 10: read-only feed of the campaign_metrics table for
// the Leads tab analytics strip. Compute via:
//   node scripts/compute-campaign-metrics.mjs
// (cron candidate later — for now, on-demand).
export async function GET() {
  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("campaign_metrics")
      .select("*")
      .order("total_leads", { ascending: false })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ rows: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
