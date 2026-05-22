import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const { id, notes } = await request.json()

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }
    const value = typeof notes === "string" ? notes.trim() : ""

    // A manual notes save counts as re-verifying the contact, so enriched_at
    // is refreshed — which resets the 90-day staleness clock. (Pre-migration
    // the sheet-backed route instead preserved the old [enriched:] marker;
    // enriched_at is a real column now, so the marker hack is gone.)
    const supabase = getLeadsClient()
    const { error } = await supabase
      .from("relationships")
      .update({ notes: value || null, enriched_at: new Date().toISOString() })
      .eq("id", id)
    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("crms/notes error:", err)
    return NextResponse.json({ error: "Failed to update notes" }, { status: 500 })
  }
}
