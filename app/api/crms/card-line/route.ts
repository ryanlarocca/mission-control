import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Card # toggle on a Relationships contact (2026-10-26). ON = calls and texts
// to them go from the business-card line (408) 458-5442 instead of Ryan's
// cell (/api/crms/call, /api/crms/send read the flag server-side).
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const { id, on } = await request.json()
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }
    if (typeof on !== "boolean") {
      return NextResponse.json({ error: "on must be true or false" }, { status: 400 })
    }
    const { data, error } = await getLeadsClient()
      .from("relationships")
      .update({ use_card_line: on })
      .eq("id", id)
      .select("id")
    if (error) throw error
    if (!data?.length) return NextResponse.json({ error: "contact not found" }, { status: 404 })
    return NextResponse.json({ ok: true, on })
  } catch (err) {
    console.error("crms/card-line error:", err)
    return NextResponse.json({ error: "Failed to update Card # setting" }, { status: 500 })
  }
}
