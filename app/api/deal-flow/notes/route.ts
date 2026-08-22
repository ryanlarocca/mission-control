import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { fetchAllNotes, insertNote, deleteNote } from "@/lib/dealFlow"

// Deal Flow comments.
//   GET               → all notes (the page groups them by address)
//   POST {address, body} → new note
//   DELETE {id}       → remove note
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return NextResponse.json({ notes: await fetchAllNotes(getLeadsClient()) })
  } catch (err) {
    console.error("deal-flow notes GET:", err)
    return NextResponse.json({ error: "notes load failed" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const { address, body } = await request.json()
    if (typeof address !== "string" || !address.trim() || typeof body !== "string" || !body.trim()) {
      return NextResponse.json({ error: "address and body are required" }, { status: 400 })
    }
    const note = await insertNote(getLeadsClient(), address.trim(), body.trim())
    return NextResponse.json({ note })
  } catch (err) {
    console.error("deal-flow notes POST:", err)
    return NextResponse.json({ error: "note save failed" }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const { id } = await request.json()
    if (typeof id !== "string" || !id) return NextResponse.json({ error: "id required" }, { status: 400 })
    await deleteNote(getLeadsClient(), id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("deal-flow notes DELETE:", err)
    return NextResponse.json({ error: "note delete failed" }, { status: 500 })
  }
}
