import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Pin on a Relationships contact (2026-11-18). Pinned = someone with a lead
// for Ryan: they sit in the Pinned section at the top of the tab every day
// until he unpins them. `note` is his optional few words about the lead.
//   { id, pinned: true, note? }  pin, or edit the note of someone pinned
//   { id, pinned: false }        unpin (the note is cleared too)
export const dynamic = "force-dynamic"

const NOTE_MAX = 140

export async function POST(request: Request) {
  try {
    const { id, pinned, note } = await request.json()
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }
    if (typeof pinned !== "boolean") {
      return NextResponse.json({ error: "pinned must be true or false" }, { status: 400 })
    }
    if (note != null && typeof note !== "string") {
      return NextResponse.json({ error: "note must be text" }, { status: 400 })
    }
    const sb = getLeadsClient()
    const pinNote = pinned ? (note ?? "").trim().slice(0, NOTE_MAX) || null : null

    // Keep the original pin date when only the note changes.
    let pinnedAt: string | null = null
    if (pinned) {
      const { data: cur, error: readErr } = await sb.from("relationships").select("pinned_at").eq("id", id).maybeSingle()
      if (readErr) throw readErr
      if (!cur) return NextResponse.json({ error: "contact not found" }, { status: 404 })
      pinnedAt = (cur.pinned_at as string | null) ?? new Date().toISOString()
    }

    const { data, error } = await sb
      .from("relationships")
      .update({ pinned_at: pinnedAt, pin_note: pinNote })
      .eq("id", id)
      .select("id")
    if (error) throw error
    if (!data?.length) return NextResponse.json({ error: "contact not found" }, { status: 404 })
    return NextResponse.json({ ok: true, pinnedAt, pinNote: pinNote ?? "" })
  } catch (err) {
    console.error("crms/pin error:", err)
    return NextResponse.json({ error: "Failed to update the pin" }, { status: 500 })
  }
}
