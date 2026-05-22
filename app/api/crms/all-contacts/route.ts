import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { fetchAllRelationships, toApiContact } from "@/lib/relationships"

// Full BoB dump for the Relationships-tab search box. Unlike /api/crms/contacts
// (today's cadence-due queue, capped per type) this returns EVERY contact so
// Ryan can look anyone up — including tier E, snoozed, and phoneless contacts
// that never surface in the queue.
export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  try {
    const supabase = getLeadsClient()
    const rows = await fetchAllRelationships(supabase)
    const contacts = rows
      .map(toApiContact)
      .sort((a, b) => a.name.localeCompare(b.name))
    return NextResponse.json({ contacts, total: contacts.length })
  } catch (err) {
    console.error("crms/all-contacts error:", err)
    return NextResponse.json({ error: "Failed to fetch contacts" }, { status: 500 })
  }
}
