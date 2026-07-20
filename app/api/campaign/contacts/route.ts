import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Campaign contacts list — powers the /email-campaign Contacts tab.
// ?q= searches name/email/phone, ?status= filters. Fast-review mode
// (2026-07-20): 500/page default, UI appends pages to reach the full list.

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const url = request.nextUrl
  const q = (url.searchParams.get("q") ?? "").trim()
  const status = url.searchParams.get("status") ?? ""
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0))
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 500)))

  try {
    const sb = getLeadsClient()
    let query = sb
      .from("campaign_contacts")
      .select(
        "id, name, email, phone, phone_bad, status, touch_number, next_touch_at, last_sent_at, import_flags, property_address",
        { count: "exact" }
      )
      .order("name", { ascending: true })
      .range(page * limit, page * limit + limit - 1)
    if (status) query = query.eq("status", status)
    if (q) {
      const like = `%${q.replace(/[%_]/g, "")}%`
      const digits = q.replace(/\D/g, "")
      const ors = [`name.ilike.${like}`, `email.ilike.${like}`]
      if (digits.length >= 4) ors.push(`phone.ilike.%${digits}%`)
      query = query.or(ors.join(","))
    }
    const { data, count, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // status rollup for the header chips
    const statuses = ["active", "paused", "replied", "bounced", "unsubscribed", "suppressed", "bad_email", "no_email"]
    const counts = await Promise.all(
      statuses.map((s) =>
        sb.from("campaign_contacts").select("id", { count: "exact", head: true }).eq("status", s)
      )
    )
    const buckets: Record<string, number> = {}
    statuses.forEach((s, i) => {
      buckets[s] = counts[i].count ?? 0
    })

    return NextResponse.json({ contacts: data ?? [], total: count ?? 0, buckets })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
