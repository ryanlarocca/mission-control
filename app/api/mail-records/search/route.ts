import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { MAIL_RECORD_LITE_COLUMNS, normStreet, normSurname, type MailRecordLite } from "@/lib/mailMatch"

// Mailed-record lookup for the lead card picker.
//   ?ids=a,b,c                       → those records (candidate lists)
//   ?q=<street or last name>[&campaign=<id>] → up to 20 matches
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
    const campaign = sp.get("campaign")
    const street = normStreet(q)
    const surname = normSurname(q)
    const pat = (s: string) => `%${s.replace(/[%_]/g, "")}%`
    let query = sb
      .from("mail_records")
      .select(MAIL_RECORD_LITE_COLUMNS)
      .or(
        [
          street ? `site_street_norm.ilike.${pat(street)}` : null,
          street ? `mail_line_norm.ilike.${pat(street)}` : null,
          surname ? `owner_surname_norm.ilike.${pat(surname)}` : null,
          `owner_name_norm.ilike.${pat(q.toUpperCase())}`,
        ]
          .filter(Boolean)
          .join(",")
      )
      .order("arm", { ascending: true })
      .limit(20)
    if (campaign && /^[0-9a-f-]{36}$/i.test(campaign)) query = query.eq("campaign_id", campaign)
    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ records: (data ?? []) as unknown as MailRecordLite[] })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
