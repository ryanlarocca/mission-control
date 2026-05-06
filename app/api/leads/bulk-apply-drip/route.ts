import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Phase 7C — Part 6: bulk-assign drip campaigns to many leads at once.
//
// Each lead is auto-routed by available contact data (phone wins). Leads
// already on a campaign or flagged DNC/Junk are skipped, not rejected, so
// the partial-success case still returns 200 with a per-lead breakdown.
export async function POST(request: NextRequest) {
  let body: { leadIds?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const ids = Array.isArray(body.leadIds)
    ? (body.leadIds as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0)
    : []
  if (ids.length === 0) {
    return NextResponse.json({ error: "leadIds (string[]) required" }, { status: 400 })
  }

  try {
    const sb = getLeadsClient()
    const { data: leads, error } = await sb
      .from("leads")
      .select("id, caller_phone, email, drip_campaign_type, is_dnc, is_junk")
      .in("id", ids)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const results: Array<{ id: string; ok: boolean; reason?: string; campaign_type?: string }> = []
    for (const lead of leads || []) {
      if (lead.is_dnc || lead.is_junk) {
        results.push({ id: lead.id, ok: false, reason: "flagged_dnc_or_junk" })
        continue
      }
      if (lead.drip_campaign_type) {
        results.push({ id: lead.id, ok: false, reason: "already_on_campaign" })
        continue
      }
      const campaignType =
        lead.caller_phone
          ? "direct_mail_call"
          : lead.email
          ? "direct_mail_email"
          : null
      if (!campaignType) {
        results.push({ id: lead.id, ok: false, reason: "no_phone_or_email" })
        continue
      }
      const { error: updErr } = await sb
        .from("leads")
        .update({
          drip_campaign_type: campaignType,
          drip_touch_number: 0,
          last_drip_sent_at: new Date().toISOString(),
        })
        .eq("id", lead.id)
      if (updErr) {
        results.push({ id: lead.id, ok: false, reason: updErr.message })
      } else {
        results.push({ id: lead.id, ok: true, campaign_type: campaignType })
      }
    }

    const succeeded = results.filter((r) => r.ok).length
    return NextResponse.json({
      ok: true,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
