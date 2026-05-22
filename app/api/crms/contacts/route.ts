import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import {
  CADENCE, DAILY_TARGETS, RELATIONSHIP_TYPES,
  daysSince, emptyBuckets, fetchAllRelationships, interleave, toApiContact,
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

    // Sort each bucket: notes first, then most overdue, then tier A > B > C > D.
    const tierOrder: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 }
    const fullBuckets = emptyBuckets()
    for (const t of ALL_TYPES) {
      buckets[t].sort((a, b) => {
        if (a.hasNotes !== b.hasNotes) return a.hasNotes ? -1 : 1
        if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue
        return (tierOrder[a.tier] ?? 3) - (tierOrder[b.tier] ?? 3)
      })
      fullBuckets[t] = buckets[t]
      buckets[t] = buckets[t].slice(0, DAILY_TARGETS[t])
    }

    // Backfill: redistribute any queue shortfall to Agent so the queue
    // always delivers totalTarget contacts when supply allows.
    const totalTargetVal = ALL_TYPES.reduce((s, t) => s + DAILY_TARGETS[t], 0)
    const totalFilled = ALL_TYPES.reduce((s, t) => s + buckets[t].length, 0)
    const shortfall = Math.max(0, totalTargetVal - totalFilled)
    if (shortfall > 0) {
      const agentOverflow = fullBuckets.Agent.slice(
        DAILY_TARGETS.Agent, DAILY_TARGETS.Agent + shortfall
      )
      buckets.Agent = [...buckets.Agent, ...agentOverflow]
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
