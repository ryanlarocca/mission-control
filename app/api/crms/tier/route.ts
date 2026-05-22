import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

export const dynamic = "force-dynamic"

const VALID_TIERS = new Set(["A", "B", "C", "D", "E"])

export async function POST(request: Request) {
  try {
    const { id, tier } = await request.json()

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }
    const t = String(tier || "").trim().toUpperCase()
    if (!VALID_TIERS.has(t)) {
      return NextResponse.json({ error: "tier must be A, B, C, D, or E" }, { status: 400 })
    }

    const supabase = getLeadsClient()
    const { error } = await supabase.from("relationships").update({ tier: t }).eq("id", id)
    if (error) throw error

    return NextResponse.json({ success: true, tier: t })
  } catch (err) {
    console.error("crms/tier error:", err)
    return NextResponse.json({ error: "Failed to update tier" }, { status: 500 })
  }
}
