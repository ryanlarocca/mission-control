import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import {
  MAIL_RECORD_LITE_COLUMNS,
  mailSearchCampaignId,
  normStreet,
  normSurname,
  parseFreeAddress,
  type CampaignScopeLite,
  type MailRecordLite,
} from "@/lib/mailMatch"

// Mailed-record lookup for the lead card picker.
//   ?ids=a,b,c                       → those records (candidate lists)
//   ?q=<street or last name>[&campaign=<id>] → up to 20 matches
//
// Scope: when `campaign` is an A/B piece child (NOO Q4 2026 — A / B), the
// records live on the PARENT, so the search widens to the parent's records
// (same rule as autoLinkMailRecord). A query with a house number is an
// address: match streets only, so "4032 Ross Park Ct" isn't crowded out of
// the 20-row cap by every owner surnamed Park / Parker.
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams
  const sb = getLeadsClient()
  try {
    const ids = (sp.get("ids") ?? "").split(",").map(s => s.trim()).filter(s => /^[0-9a-f-]{36}$/i.test(s))
    if (ids.length) {
      const { data, error } = await sb.from("mail_records").select(MAIL_RECORD_LITE_COLUMNS).in("id", ids.slice(0, 50))
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ records: (data ?? []) as unknown as MailRecordLite[] })
    }
    const q = (sp.get("q") ?? "").trim()
    if (q.length < 2) return NextResponse.json({ records: [] })
    const campaignParam = sp.get("campaign")
    let scopeId: string | null = null
    if (campaignParam && /^[0-9a-f-]{36}$/i.test(campaignParam)) {
      const { data: c } = await sb
        .from("campaigns")
        .select("id, parent_campaign_id, piece")
        .eq("id", campaignParam)
        .maybeSingle()
      scopeId = mailSearchCampaignId((c as CampaignScopeLite | null) ?? null, campaignParam)
    }
    const street = normStreet(q)
    const surname = normSurname(q)
    const isAddress = parseFreeAddress(q).hasNumber
    const pat = (s: string) => `%${s.replace(/[%_]/g, "")}%`
    const filters = isAddress
      ? [street ? `site_street_norm.ilike.${pat(street)}` : null, street ? `mail_line_norm.ilike.${pat(street)}` : null]
      : [
          street ? `site_street_norm.ilike.${pat(street)}` : null,
          street ? `mail_line_norm.ilike.${pat(street)}` : null,
          surname ? `owner_surname_norm.ilike.${pat(surname)}` : null,
          `owner_name_norm.ilike.${pat(q.toUpperCase())}`,
        ]
    let query = sb
      .from("mail_records")
      .select(MAIL_RECORD_LITE_COLUMNS)
      .or(filters.filter(Boolean).join(","))
      .order("arm", { ascending: true })
      .limit(20)
    if (scopeId) query = query.eq("campaign_id", scopeId)
    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ records: (data ?? []) as unknown as MailRecordLite[] })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
