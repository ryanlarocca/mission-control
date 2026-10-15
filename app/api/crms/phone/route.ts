import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { parseUsPhone10, planPhoneChange, relationshipsByAnyPhone, to10Digit } from "@/lib/relationships"

export const dynamic = "force-dynamic"

// Change the number the Call/Text buttons dial (2026-10-15). The old main
// number is kept as an extra (alt_phones) so a call from it still lands on
// this card; promoting an extra pulls it out of that list. Touches stay put —
// they hang off relationship_id, not the phone.

function fmt(phone10: string): string {
  return `(${phone10.slice(0, 3)}) ${phone10.slice(3, 6)}-${phone10.slice(6)}`
}

export async function POST(request: Request) {
  try {
    const { id, phone } = await request.json()

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }
    const phone10 = parseUsPhone10(typeof phone === "string" ? phone : "")
    if (!phone10) {
      return NextResponse.json({ error: "Enter a 10-digit US number" }, { status: 400 })
    }

    const supabase = getLeadsClient()
    const taken = (await relationshipsByAnyPhone<{ id: string; name: string | null }>(supabase, phone10, "id, name, status")).find(r => r.id !== id)
    if (taken) {
      return NextResponse.json({ error: `That number is already on ${taken.name || "another"}'s card` }, { status: 409 })
    }

    const { data: row, error: readErr } = await supabase
      .from("relationships")
      .select("id, phone, alt_phones, notes")
      .eq("id", id)
      .single()
    if (readErr || !row) throw readErr ?? new Error("contact not found")

    const next = planPhoneChange(row, phone10)
    if (!next) return NextResponse.json({ error: "Enter a 10-digit US number" }, { status: 400 })
    const old10 = to10Digit(row.phone)
    const day = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
    const line = old10.length === 10
      ? `Phone changed on the card ${day}: ${fmt(old10)} → ${fmt(phone10)} (old number kept as an extra).`
      : `Phone added on the card ${day}: ${fmt(phone10)}.`
    const prevNotes = String(row.notes ?? "").trim()
    const { error } = await supabase
      .from("relationships")
      .update({ ...next, notes: prevNotes ? `${prevNotes}\n\n${line}` : line })
      .eq("id", id)
    if (error) throw error

    return NextResponse.json({ success: true, phone: phone10, altPhones: next.alt_phones.map(to10Digit) })
  } catch (err) {
    console.error("crms/phone error:", err)
    return NextResponse.json({ error: "Failed to update phone" }, { status: 500 })
  }
}
