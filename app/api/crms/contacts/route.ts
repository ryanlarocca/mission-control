import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import {
  CADENCE, DAILY_TARGETS, RELATIONSHIP_TYPES,
  daysSince, emptyBuckets, fetchAllRelationships, interleave, queueOrder, toApiContact,
} from "@/lib/relationships"

// Today's cadence-due outreach queue, capped per category and interleaved.
// Backed by the Supabase `relationships` table since the 2026-05-22 migration.
export const dynamic = "force-dynamic"
export const revalidate = 0

const ALL_TYPES = RELATIONSHIP_TYPES

export async function GET() {
  try {
    const supabase = getLeadsClient()
    const rows = await fetchAllRelationships(supabase)
    console.log(`[crms/contacts] relationships table returned ${rows.length} rows`)

    const buckets = emptyBuckets()
    const totalDueByType: Record<string, number> = {
      Agent: 0, Vendor: 0, Personal: 0, PM: 0, Investor: 0, PrivateMoney: 0, Seller: 0,
    }
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
      buckets[c.type].push(c)
      totalDueByType[c.type]++
    }

    // Sort each bucket: tier first, then real history over never-contacted,
    // then most recently talked-to (see queueOrder).
    const fullBuckets = emptyBuckets()
    for (const t of ALL_TYPES) {
      buckets[t].sort(queueOrder)
      fullBuckets[t] = buckets[t]
      buckets[t] = buckets[t].slice(0, DAILY_TARGETS[t])
    }

    // Backfill: fill any queue shortfall from ANY category's leftover due
    // contacts (same queueOrder priority as above) so the
    // queue always delivers totalTarget when supply allows. Was Agent-only
    // until 2026-08-21 — with 0 agents due that left a 1-person queue while
    // 65 Personal/Seller/Investor/PM contacts sat overdue.
    const totalTargetVal = ALL_TYPES.reduce((s, t) => s + DAILY_TARGETS[t], 0)
    const totalFilled = ALL_TYPES.reduce((s, t) => s + buckets[t].length, 0)
    const shortfall = Math.max(0, totalTargetVal - totalFilled)
    if (shortfall > 0) {
      const leftovers = ALL_TYPES.flatMap((t) =>
        fullBuckets[t].slice(DAILY_TARGETS[t]).map((c) => ({ t, c }))
      )
      leftovers.sort((x, y) => queueOrder(x.c, y.c))
      for (const { t, c } of leftovers.slice(0, shortfall)) buckets[t].push(c)
    }

    const queue = interleave(buckets)
    const totalTarget = ALL_TYPES.reduce((s, t) => s + DAILY_TARGETS[t], 0)
    const totalDue = ALL_TYPES.reduce((s, t) => s + totalDueByType[t], 0)

    return NextResponse.json({
      contacts: queue,
      total: totalDue,
      totalDue,
      totalTarget,
      dailyTarget: DAILY_TARGETS,
      dueByType: totalDueByType,
      fetchedAt: now.toISOString(),
    })
  } catch (err) {
    console.error("crms/contacts error:", err)
    return NextResponse.json({ error: "Failed to fetch contacts" }, { status: 500 })
  }
}
