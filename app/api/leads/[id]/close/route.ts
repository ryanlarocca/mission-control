import { NextRequest, NextResponse } from "next/server"
import { closeLeadDead } from "@/lib/reply/execute"

// Reply Planner "Close (dead)" from the card. Closes the lead, or DNCs the
// contact when their latest message is an explicit remove request.
export const dynamic = "force-dynamic"

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
  try {
    const note = await closeLeadDead(id)
    return NextResponse.json({ ok: true, note })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
