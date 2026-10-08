import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Zip-cut picker for a direct-mail list build (campaign_zips). GET lists the
// campaign's site zips; PATCH flips `exclude` on one zip. The list-build
// script reads exclude = true back as the Step 6 zip cut.

export const dynamic = "force-dynamic"

export interface CampaignZip {
  id: string
  campaign_id: string
  zip: string
  city: string | null
  county: string | null
  rows: number
  median_year_built: number | null
  median_tenure_years: number | null
  cumulative_in_county: number | null
  exclude: boolean
  updated_at: string
}

type Ctx = { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const sb = getLeadsClient()
    const [{ data: campaign, error: cErr }, { data, error }] = await Promise.all([
      sb.from("campaigns").select("id, name").eq("id", params.id).maybeSingle(),
      sb
        .from("campaign_zips")
        .select("*")
        .eq("campaign_id", params.id)
        .order("county", { ascending: true })
        .order("rows", { ascending: false }),
    ])
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
    if (!campaign) return NextResponse.json({ error: "campaign not found" }, { status: 404 })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ campaign, zips: (data ?? []) as CampaignZip[] })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  let body: { zip?: unknown; exclude?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const zip = typeof body.zip === "string" ? body.zip.trim() : ""
  if (!/^\d{5}$/.test(zip) || typeof body.exclude !== "boolean") {
    return NextResponse.json({ error: "zip (5 digits) and exclude (boolean) required" }, { status: 400 })
  }
  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("campaign_zips")
      .update({ exclude: body.exclude, updated_at: new Date().toISOString() })
      .eq("campaign_id", params.id)
      .eq("zip", zip)
      .select("zip, exclude")
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: "zip not in this campaign" }, { status: 404 })
    return NextResponse.json({ ok: true, ...data })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
