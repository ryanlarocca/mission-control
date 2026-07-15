import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { isDateKey } from "@/lib/board"
import { fetchActivePeriod, fetchPeriodEvents } from "@/lib/boardDb"

// The Board — 90-day rep tracker snapshot.
//
//   GET ?date=YYYY-MM-DD   period containing the client's local "today"
//                          (fallback: most recent period) + all its events.
//
// All quota / stat math happens client-side in lib/board.ts over the raw
// event list, so this route stays a dumb read.
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const date = url.searchParams.get("date")
    if (!isDateKey(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD is required" }, { status: 400 })
    }

    const supabase = getLeadsClient()
    const period = await fetchActivePeriod(supabase, date)
    if (!period) return NextResponse.json({ period: null, events: [] })

    const events = await fetchPeriodEvents(supabase, period.id)
    return NextResponse.json({ period, events })
  } catch (err) {
    console.error("board GET error:", err)
    return NextResponse.json({ error: "board load failed" }, { status: 500 })
  }
}
