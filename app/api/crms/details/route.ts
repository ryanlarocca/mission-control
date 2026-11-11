import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Edit a Relationships contact's name or email from the card (2026-11-11).
// Phone has its own route (/api/crms/phone) because it carries extras and a
// duplicate check; name and email are plain fields. Send only the field being
// changed. An empty email clears it.
export const dynamic = "force-dynamic"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { id } = body ?? {}
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }

    const update: { name?: string; email?: string | null } = {}
    if ("name" in body) {
      const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : ""
      if (!name) return NextResponse.json({ error: "Name can't be blank" }, { status: 400 })
      if (name.length > 120) return NextResponse.json({ error: "Name is too long" }, { status: 400 })
      update.name = name
    }
    if ("email" in body) {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
      if (email && !EMAIL_RE.test(email)) {
        return NextResponse.json({ error: "That doesn't look like an email address" }, { status: 400 })
      }
      update.email = email || null
    }
    if (!Object.keys(update).length) {
      return NextResponse.json({ error: "Nothing to change" }, { status: 400 })
    }

    const { data, error } = await getLeadsClient()
      .from("relationships")
      .update(update)
      .eq("id", id)
      .select("id, name, email")
    if (error) throw error
    if (!data?.length) return NextResponse.json({ error: "contact not found" }, { status: 404 })
    return NextResponse.json({ ok: true, name: data[0].name, email: data[0].email })
  } catch (err) {
    console.error("crms/details error:", err)
    return NextResponse.json({ error: "Failed to save" }, { status: 500 })
  }
}
