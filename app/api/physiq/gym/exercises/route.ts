import { NextRequest, NextResponse } from "next/server"
import { addExercise } from "@/lib/physiqSupabase"

// Create a new exercise (strength or cardio).
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  let body: { name?: string; category?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const name = (body.name ?? "").trim()
  const category = body.category
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 })
  }
  if (category !== "strength" && category !== "cardio") {
    return NextResponse.json(
      { error: "category must be 'strength' or 'cardio'" },
      { status: 400 }
    )
  }

  try {
    const { id } = await addExercise({ name, category })
    return NextResponse.json({ id })
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to add exercise"
    // Unique (user_id, name) violation → friendly message.
    const status = /duplicate key|unique/i.test(msg) ? 409 : 500
    return NextResponse.json(
      { error: status === 409 ? "You already have an exercise with that name." : msg },
      { status }
    )
  }
}
