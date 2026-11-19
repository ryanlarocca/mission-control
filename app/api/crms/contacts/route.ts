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
//
// 2026-11-18 (Ryan): pinned contacts (someone who handed him a lead) come back
// in `pinned` every day — due or not, snoozed or not, phone or not — and stay
// out of the due queue. Longest since last contact first. `inQueue` says
// whether they're also due today, so unpinning in the tab drops them back
// into the queue only if they belong there.
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
    const pinned: (ApiContact & { inQueue: boolean })[] = []
    const now = new Date()

    const isDue = (row: (typeof rows)[number]): boolean => {
      if (!row.phone) return false                       // phoneless contacts can't be queued
      if (row.status === "do_not_contact") return false  // removed from rotation
      const tier = (row.tier || "C").trim().toUpperCase()
      if (tier === "E") return false                     // tier E = excluded from queue
      if (row.snooze_until && new Date(row.snooze_until) > now) return false
      const lastDate = row.last_contacted_at ? new Date(row.last_contacted_at) : null
      const cadenceDays = CADENCE[tier] ?? 45
      return daysSince(lastDate) >= cadenceDays
    }

    for (const row of rows) {
      const due = isDue(row)
      if (row.pinned_at && row.status !== "do_not_contact") {
        pinned.push({ ...toApiContact(row), inQueue: due })
        continue
      }
      if (!due) continue
      const c = toApiContact(row)
      dueByType[c.type]++
      ;(c.type === "Agent" ? agents : others).push(c)
    }

    agents.sort(queueOrder)
    others.sort(queueOrder)
    const queue = [...agents, ...others]
    const lastMs = (id: string) => {
      const at = rows.find((r) => r.id === id)?.last_contacted_at
      return at ? new Date(at).getTime() : 0
    }
    pinned.sort((a, b) => lastMs(a.id) - lastMs(b.id))

    return NextResponse.json({
      contacts: queue,
      pinned,
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
