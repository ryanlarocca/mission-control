import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { isDateKey } from "@/lib/board"
import { PERIOD_COLUMNS } from "@/lib/boardDb"

// Goal-period config — the "90 days" is data, not code.
//
//   GET                                        list periods (newest first)
//   POST  { label, starts_on, ends_on }        create a new block
//   PATCH { id, label?, starts_on?, ends_on? } adjust an existing block
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const { data, error } = await getLeadsClient()
      .from("board_periods")
      .select(PERIOD_COLUMNS)
      .order("starts_on", { ascending: false })
    if (error) throw error
    return NextResponse.json({ periods: data })
  } catch (err) {
    console.error("board periods GET error:", err)
    return NextResponse.json({ error: "lookup failed" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const label = String(body.label ?? "").trim()
    if (!label) return NextResponse.json({ error: "label is required" }, { status: 400 })
    if (!isDateKey(body.starts_on) || !isDateKey(body.ends_on) || body.ends_on < body.starts_on) {
      return NextResponse.json({ error: "starts_on/ends_on must be YYYY-MM-DD with ends_on >= starts_on" }, { status: 400 })
    }

    const { data, error } = await getLeadsClient()
      .from("board_periods")
      .insert({ label, starts_on: body.starts_on, ends_on: body.ends_on })
      .select(PERIOD_COLUMNS)
      .single()
    if (error) throw error
    return NextResponse.json({ success: true, period: data })
  } catch (err) {
    console.error("board periods POST error:", err)
    return NextResponse.json({ error: "create failed" }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json()
    const id = String(body.id ?? "")
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })

    const update: Record<string, unknown> = {}
    if (body.label !== undefined) {
      const label = String(body.label).trim()
      if (!label) return NextResponse.json({ error: "label cannot be blank" }, { status: 400 })
      update.label = label
    }
    if (body.starts_on !== undefined) {
      if (!isDateKey(body.starts_on)) return NextResponse.json({ error: "invalid starts_on" }, { status: 400 })
      update.starts_on = body.starts_on
    }
    if (body.ends_on !== undefined) {
      if (!isDateKey(body.ends_on)) return NextResponse.json({ error: "invalid ends_on" }, { status: 400 })
      update.ends_on = body.ends_on
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "no fields to update" }, { status: 400 })
    }

    const { data, error } = await getLeadsClient()
      .from("board_periods")
      .update(update)
      .eq("id", id)
      .select(PERIOD_COLUMNS)
    if (error) throw error
    if (!data.length) return NextResponse.json({ error: "period not found" }, { status: 404 })
    return NextResponse.json({ success: true, period: data[0] })
  } catch (err) {
    console.error("board periods PATCH error:", err)
    return NextResponse.json({ error: "update failed" }, { status: 500 })
  }
}
