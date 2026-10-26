import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { fetchFullHistory } from "@/lib/lead-history"

// Full history for one Follow Ups card — every call / voicemail / text /
// email for the contact, newest first, with the full text attached. The
// card fetches this on tap (▸ on a line, or "Show all"); the worklist
// payload itself only carries the one-line preview. `key` = the row's
// clusterKey (phone:… / thread:… / email:… / id:…).
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key") || ""
  if (!/^(phone|thread|email|id):.+/.test(key)) {
    return NextResponse.json({ error: "key required" }, { status: 400 })
  }
  try {
    const items = await fetchFullHistory(getLeadsClient(), key)
    return NextResponse.json({ items })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[follow-ups:history] error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
