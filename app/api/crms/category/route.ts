import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { isValidCategory, RELATIONSHIP_CATEGORIES } from "@/lib/crms"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const { id, category } = await request.json()

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }
    const c = String(category || "").trim()
    if (!isValidCategory(c)) {
      return NextResponse.json(
        { error: `category must be one of: ${RELATIONSHIP_CATEGORIES.join(", ")}` },
        { status: 400 }
      )
    }

    const supabase = getLeadsClient()
    const { error } = await supabase.from("relationships").update({ category: c }).eq("id", id)
    if (error) throw error

    return NextResponse.json({ success: true, category: c })
  } catch (err) {
    console.error("crms/category error:", err)
    return NextResponse.json({ error: "Failed to update category" }, { status: 500 })
  }
}
