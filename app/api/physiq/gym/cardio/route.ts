import { NextRequest, NextResponse } from "next/server"
import { getCardio, insertCardio } from "@/lib/physiqSupabase"

// Cardio sessions: list (GET) + log (POST).
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const sessions = await getCardio()
    return NextResponse.json({ sessions })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load cardio" },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  let body: {
    date?: string
    exercise_name?: string
    duration_minutes?: number | null
    speed_mph?: number | null
    incline_pct?: number | null
    notes?: string | null
  } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.date || !body.exercise_name?.trim()) {
    return NextResponse.json(
      { error: "date and exercise_name are required" },
      { status: 400 }
    )
  }

  const num = (v: unknown) => (v == null || v === "" ? null : Number(v))

  try {
    const session = await insertCardio({
      date: body.date,
      exercise_name: body.exercise_name,
      duration_minutes: num(body.duration_minutes),
      speed_mph: num(body.speed_mph),
      incline_pct: num(body.incline_pct),
      notes: body.notes ?? null,
    })
    return NextResponse.json({ session })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to log cardio" },
      { status: 500 }
    )
  }
}
