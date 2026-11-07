import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { storeRyanNoteById } from "@/lib/marketCycle/data"

export const dynamic = "force-dynamic"

// Web "Disagree" on /cycle (brief v2 P3.5): the same note the Telegram
// Disagree button stores — appended to the review's ryan_note, shown to the
// next review. Never moves the odds by itself. Auth: the mc_session cookie
// (middleware; /api/cycle is not public).
export async function POST(request: Request) {
  try {
    const { checkpoint_id, note } = (await request.json()) as { checkpoint_id?: unknown; note?: unknown }
    if (typeof checkpoint_id !== "string" || !/^[0-9a-f-]{36}$/.test(checkpoint_id)) {
      return NextResponse.json({ error: "checkpoint_id required" }, { status: 400 })
    }
    const text = typeof note === "string" ? note.trim() : ""
    if (!text) return NextResponse.json({ error: "note required" }, { status: 400 })
    if (text.length > 2000) return NextResponse.json({ error: "note too long (2,000 characters max)" }, { status: 400 })
    const date = await storeRyanNoteById(getLeadsClient(), checkpoint_id, text)
    if (!date) return NextResponse.json({ error: "review not found" }, { status: 404 })
    return NextResponse.json({ ok: true, date })
  } catch (err) {
    console.error("cycle/note error:", err)
    return NextResponse.json({ error: "Failed to save the note" }, { status: 500 })
  }
}
