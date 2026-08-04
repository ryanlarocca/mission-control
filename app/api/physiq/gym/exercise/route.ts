import { NextRequest, NextResponse } from "next/server"
import { getExerciseHistory } from "@/lib/physiqSupabase"

// Full history for one exercise (?id=<exercise uuid>) — the detail sheet's
// data source. force-dynamic for the same stale-GET reason as ./strength.
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id")
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 })
  }
  try {
    const history = await getExerciseHistory(id)
    return NextResponse.json(history)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load exercise history" },
      { status: 500 }
    )
  }
}
