import { NextRequest, NextResponse } from "next/server"
import { getStrengthBoard, insertStrengthSet } from "@/lib/physiqSupabase"

// Strength board (GET) + log a set (POST). Reads the Physiq Supabase project
// server-side with the service_role key; the browser never touches Supabase
// directly. force-dynamic so the board never serves a stale snapshot after a
// log (see getLeadsClient note about Next caching GET routes).
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const cards = await getStrengthBoard()
    return NextResponse.json({ cards })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load strength board" },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  let body: {
    exerciseId?: string
    date?: string
    weight_lbs?: number
    reps?: number
    notes?: string | null
  } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.exerciseId || !body.date || body.weight_lbs == null || body.reps == null) {
    return NextResponse.json(
      { error: "exerciseId, date, weight_lbs, and reps are required" },
      { status: 400 }
    )
  }

  try {
    const result = await insertStrengthSet({
      exerciseId: body.exerciseId,
      date: body.date,
      weight_lbs: Number(body.weight_lbs),
      reps: Number(body.reps),
      notes: body.notes ?? null,
    })
    return NextResponse.json({ set: result.set, isNewPr: result.isNewPr })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to log set" },
      { status: 500 }
    )
  }
}
