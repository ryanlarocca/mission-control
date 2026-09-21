import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import {
  CADENCE, RELATIONSHIP_TYPES,
  daysSince, fetchAllRelationships, queueOrder, toApiContact,
} from "@/lib/relationships"
import type { ApiContact } from "@/lib/relationships"

// Everyone who is cadence-due today, in call order. Backed by the Supabase
// `relationships` table since the 2026-05-22 migration.
//
// 2026-09-21 (Ryan): the queue used to be capped at 5/day (per-category
// targets + backfill + weighted interleave). He now works the whole due list
// in one sitting, so this returns every due contact: Agents first, then
// everyone else, each group in queueOrder (tier, real history before
// never-contacted, most recently talked-to).
export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  try {
    const supabase = getLeadsClient()
    const rows = await fetchAllRelationships(supabase)
    console.log(`[crms/contacts] relationships table returned ${rows.length} rows`)

    const dueByType: Record<string, number> = {}
    for (const t of RELATIONSHIP_TYPES) dueByType[t] = 0
    const agents: ApiContact[] = []
    const others: ApiContact[] = []
    const now = new Date()

    for (const row of rows) {
      if (!row.phone) continue                       // phoneless contacts can't be queued
      if (row.status === "do_not_contact") continue  // removed from rotation
      const tier = (row.tier || "C").trim().toUpperCase()
      if (tier === "E") continue                     // tier E = excluded from queue
      if (row.snooze_until && new Date(row.snooze_until) > now) continue

      const lastDate = row.last_contacted_at ? new Date(row.last_contacted_at) : null
      const cadenceDays = CADENCE[tier] ?? 45
      if (daysSince(lastDate) < cadenceDays) continue // not due yet

      const c = toApiContact(row)
      dueByType[c.type]++
      ;(c.type === "Agent" ? agents : others).push(c)
    }

    agents.sort(queueOrder)
    others.sort(queueOrder)
    const queue = [...agents, ...others]

    return NextResponse.json({
      contacts: queue,
      total: queue.length,
      totalDue: queue.length,
      dueByType,
      fetchedAt: now.toISOString(),
    })
  } catch (err) {
    console.error("crms/contacts error:", err)
    return NextResponse.json({ error: "Failed to fetch contacts" }, { status: 500 })
  }
}
