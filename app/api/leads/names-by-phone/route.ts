import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Batch name lookup for the Follow-Up tab. The follow-up date often lives on
// an outbound-call row with name=null, but another row for the same phone
// carries the real name. The tab POSTs the list of phone numbers it needs
// stitched names for, and we run ONE Supabase query (`.in()`) to return
// phone → name. "Anonymous" is filtered out — Twilio uses it as a literal
// payload value for blocked callers and shouldn't override a usable name.
export async function POST(request: NextRequest) {
  let body: { phones?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const phones = Array.isArray(body?.phones)
    ? (body.phones as unknown[]).filter(
        (p): p is string => typeof p === "string" && p.length > 0
      )
    : []
  if (phones.length === 0) {
    return NextResponse.json({ names: {} as Record<string, string> })
  }
  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("leads")
      .select("caller_phone, name, created_at")
      .in("caller_phone", phones)
      .not("name", "is", null)
      .neq("name", "Anonymous")
      .order("created_at", { ascending: false })
      .limit(500)
    if (error) {
      console.error("[names-by-phone] query failed:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const names: Record<string, string> = {}
    for (const row of data || []) {
      const phone = row.caller_phone as string | null
      const name = row.name as string | null
      if (!phone || !name) continue
      if (!names[phone]) names[phone] = name
    }
    return NextResponse.json({ names })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[names-by-phone] threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
