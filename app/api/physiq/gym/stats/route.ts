import { NextResponse } from "next/server"
import { getStats } from "@/lib/physiqSupabase"

// Relative-strength tiers, DOTS score, and the strength-vs-bodyweight trend.
// Joins gym_sets with the Physiq weight_entries log (same project).
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const stats = await getStats()
    return NextResponse.json(stats)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load stats" },
      { status: 500 }
    )
  }
}
