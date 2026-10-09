import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Zip-cut + Arm A sizing picker for a direct-mail list build (campaign_zips).
// GET lists the campaign's site zips plus the list params (Arm A tenure floor
// / target). PATCH either flips `exclude` or `arm_a_trim` on one row (by row
// id — a zip can sit in two counties), or sets `arm_a_tenure_floor` for the
// campaign. The list-build scripts read exclude = true back as the Step 6 zip
// cut and floor + arm_a_trim back as the Step 9 Arm A rule.

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
  /** No-signal pool rows by half-year tenure floor ("22.0" → rows in [22.0, 22.5)); null when the zip has no pool rows. */
  arm_a_hist: Record<string, number> | null
  /** Trimmed from Arm A only — the rows stay in the file as arm = none. */
  arm_a_trim: boolean
  updated_at: string
}

export interface CampaignListParams {
  arm_a_tenure_floor: number | null
  arm_a_target: number | null
  arm_b_count: number | null
}

type Ctx = { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const sb = getLeadsClient()
    const [{ data: campaign, error: cErr }, { data, error }, { data: lp }] = await Promise.all([
      sb.from("campaigns").select("id, name").eq("id", params.id).maybeSingle(),
      sb
        .from("campaign_zips")
        .select("*")
        .eq("campaign_id", params.id)
        .order("county", { ascending: true })
        .order("rows", { ascending: false }),
      sb.from("campaign_list_params").select("arm_a_tenure_floor, arm_a_target, arm_b_count").eq("campaign_id", params.id).maybeSingle(),
    ])
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
    if (!campaign) return NextResponse.json({ error: "campaign not found" }, { status: 404 })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const list_params: CampaignListParams = {
      arm_a_tenure_floor: lp?.arm_a_tenure_floor == null ? null : Number(lp.arm_a_tenure_floor),
      arm_a_target: lp?.arm_a_target ?? null,
      arm_b_count: lp?.arm_b_count ?? null,
    }
    return NextResponse.json({ campaign, zips: (data ?? []) as CampaignZip[], list_params })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  let body: { id?: unknown; exclude?: unknown; arm_a_trim?: unknown; arm_a_tenure_floor?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  try {
    const sb = getLeadsClient()

    // Campaign-level: the Arm A tenure floor (years, 0.5 steps; null clears).
    if ("arm_a_tenure_floor" in body) {
      const f = body.arm_a_tenure_floor
      if (f !== null && (typeof f !== "number" || !Number.isFinite(f) || f < 0 || f > 100)) {
        return NextResponse.json({ error: "arm_a_tenure_floor must be a number 0–100 or null" }, { status: 400 })
      }
      const { error } = await sb
        .from("campaign_list_params")
        .upsert({ campaign_id: params.id, arm_a_tenure_floor: f, updated_at: new Date().toISOString() }, { onConflict: "campaign_id" })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, arm_a_tenure_floor: f })
    }

    // Row-level: flip `exclude` (Step 6 zip cut) or `arm_a_trim` (Arm A only).
    const rowId = typeof body.id === "string" ? body.id.trim() : ""
    const patch: { exclude?: boolean; arm_a_trim?: boolean; updated_at: string } = { updated_at: new Date().toISOString() }
    if (typeof body.exclude === "boolean") patch.exclude = body.exclude
    if (typeof body.arm_a_trim === "boolean") patch.arm_a_trim = body.arm_a_trim
    if (!/^[0-9a-f-]{36}$/i.test(rowId) || (patch.exclude === undefined && patch.arm_a_trim === undefined)) {
      return NextResponse.json({ error: "id (uuid) and exclude or arm_a_trim (boolean) required" }, { status: 400 })
    }
    const { data, error } = await sb
      .from("campaign_zips")
      .update(patch)
      .eq("campaign_id", params.id)
      .eq("id", rowId)
      .select("id, zip, county, exclude, arm_a_trim")
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: "row not in this campaign" }, { status: 404 })
    return NextResponse.json({ ok: true, ...data })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
