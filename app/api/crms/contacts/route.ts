import { NextResponse } from "next/server"
import { getSheetsClient, SHEET_ID } from "@/lib/sheets"

export const dynamic = "force-dynamic"
export const revalidate = 0

const CADENCE: Record<string, number> = { A: 30, B: 45, C: 60, D: 365 }

type ContactType = "Agent" | "Personal" | "Vendor" | "PM" | "Investor" | "Seller"

const DAILY_TARGETS: Record<ContactType, number> = {
  Agent:    10,
  Vendor:   3,
  Personal: 2,
  PM:       0,
  Investor: 0,
  Seller:   0,
}

const ALL_TYPES: ContactType[] = ["Agent", "Vendor", "Personal", "PM", "Investor", "Seller"]

function normalizeType(raw: string): ContactType {
  const s = (raw || "").trim()
  if (s === "Property Manager") return "PM"
  if (s === "Personal Contact") return "Personal"
  if (ALL_TYPES.includes(s as ContactType)) return s as ContactType
  return "Agent"
}

function isBadName(name: string): boolean {
  const n = name.trim()
  if (!n) return true
  if (/^agent$/i.test(n)) return true
  if (/^agent\s/i.test(n)) return true
  return false
}

function normalize(phone: string): string {
  const digits = String(phone).replace(/\D/g, "")
  return digits.length >= 10 ? digits.slice(-10) : digits
}

function parseLastContacted(raw: string): Date | null {
  if (!raw || raw.trim() === "") return null
  const d = new Date(raw.trim())
  return isNaN(d.getTime()) ? null : d
}

function daysSince(date: Date | null): number {
  if (!date) return 9999
  return Math.floor((Date.now() - date.getTime()) / 86400000)
}

function parseNote(note: string): { hasNotes: boolean; notesStale: boolean; cleanNote: string } {
  if (!note || note.trim() === "") return { hasNotes: false, notesStale: false, cleanNote: "" }
  const m = note.match(/^\[enriched:\s*(\d{4}-\d{2}-\d{2})\]\s*/)
  if (!m) return { hasNotes: true, notesStale: false, cleanNote: note }
  const enrichedDate = new Date(m[1] + "T00:00:00Z")
  const stale = daysSince(enrichedDate) > 90
  return { hasNotes: true, notesStale: stale, cleanNote: note.slice(m[0].length) }
}

interface DueContact {
  id: string
  sheetRow: number
  name: string
  phone: string
  tier: string
  type: ContactType
  category: ContactType
  lastContact: string
  lastContacted: string
  daysOverdue: number
  status: "due" | "overdue"
  notes: string
  hasNotes: boolean
  notesStale: boolean
}

// Weighted round-robin: pick the bucket whose progress / target ratio is
// smallest. Naturally interleaves agents 4x more often than vendors etc.
function interleave(buckets: Record<ContactType, DueContact[]>): DueContact[] {
  const cursors: Record<string, number> = {}
  for (const t of ALL_TYPES) cursors[t] = 0
  const out: DueContact[] = []
  const totalRemaining = () => ALL_TYPES.reduce(
    (s, t) => s + Math.max(0, buckets[t].length - cursors[t]), 0
  )

  while (totalRemaining() > 0) {
    let bestType: ContactType | null = null
    let bestRatio = Infinity
    for (const t of ALL_TYPES) {
      if (cursors[t] >= buckets[t].length) continue
      const target = DAILY_TARGETS[t] || 1
      const ratio = cursors[t] / target
      if (ratio < bestRatio) { bestRatio = ratio; bestType = t }
    }
    if (!bestType) break
    out.push(buckets[bestType][cursors[bestType]])
    cursors[bestType]++
  }
  return out
}

export async function GET() {
  try {
    const sheets = getSheetsClient()
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "A1:J2000",
    })

    const rows: string[][] = (response.data.values as string[][] | null) || []
    console.log(`[crms/contacts] Sheet returned ${rows.length} rows`)

    const buckets: Record<ContactType, DueContact[]> = {
      Agent: [], Vendor: [], Personal: [], PM: [], Investor: [], Seller: [],
    }
    const totalDueByType: Record<ContactType, number> = {
      Agent: 0, Vendor: 0, Personal: 0, PM: 0, Investor: 0, Seller: 0,
    }
    const now = new Date()

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      const name        = row[0] || ""
      const phone       = row[1] || ""
      const tier        = (row[7] || "C").trim().toUpperCase()
      const noteRaw     = row[8] || ""
      const snoozeUntil = row[9] || ""

      if (!phone || normalize(phone).length < 10) continue
      if (isBadName(name)) continue
      if (tier === "E") continue
      if (snoozeUntil && new Date(snoozeUntil) > now) continue

      const lastContacted = parseLastContacted(row[6] || "")
      const cadenceDays   = CADENCE[tier] ?? 45
      const daysSinceLast = daysSince(lastContacted)
      const daysOverdue   = Math.max(0, daysSinceLast - cadenceDays)
      const isDue         = daysSinceLast >= cadenceDays
      if (!isDue) continue

      const type = normalizeType(row[4] || "Agent")
      const { hasNotes, notesStale, cleanNote } = parseNote(noteRaw)

      buckets[type].push({
        id:            `bob-${i + 1}`,
        sheetRow:      i + 1,
        name,
        phone:         normalize(phone),
        tier,
        type,
        category:      type,
        lastContact:   lastContacted ? `${daysSinceLast}d ago` : "never",
        lastContacted: row[6] || "",
        daysOverdue,
        status:        daysOverdue > 0 ? "overdue" : "due",
        notes:         cleanNote,
        hasNotes,
        notesStale,
      })
      totalDueByType[type]++
    }

    // Sort each bucket: most overdue first, then tier priority A > B > C > D
    const tierOrder: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 }
    const fullBuckets: Record<ContactType, DueContact[]> = {
      Agent: [], Vendor: [], Personal: [], PM: [], Investor: [], Seller: [],
    }
    for (const t of ALL_TYPES) {
      buckets[t].sort((a, b) => {
        if (a.hasNotes !== b.hasNotes) return a.hasNotes ? -1 : 1
        if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue
        return (tierOrder[a.tier] ?? 3) - (tierOrder[b.tier] ?? 3)
      })
      // Retain full sorted bucket for potential Agent backfill below
      fullBuckets[t] = buckets[t]
      // Cap each bucket at its daily target
      buckets[t] = buckets[t].slice(0, DAILY_TARGETS[t])
    }

    // Backfill: if Vendor/Personal (or any non-Agent type) is short of its
    // target, redistribute the shortfall to Agent so the queue always delivers
    // totalTarget contacts.
    const totalTargetVal = ALL_TYPES.reduce((s, t) => s + DAILY_TARGETS[t], 0)
    const totalFilled = ALL_TYPES.reduce((s, t) => s + buckets[t].length, 0)
    const shortfall = Math.max(0, totalTargetVal - totalFilled)
    if (shortfall > 0) {
      const agentOverflow = fullBuckets.Agent.slice(
        DAILY_TARGETS.Agent,
        DAILY_TARGETS.Agent + shortfall
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
