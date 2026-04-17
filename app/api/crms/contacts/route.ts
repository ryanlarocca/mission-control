import { NextResponse } from "next/server"
import { getSheetsClient, SHEET_ID } from "@/lib/sheets"

export const dynamic = "force-dynamic"
export const revalidate = 0

const CADENCE: Record<string, number> = { A: 30, B: 45, C: 60, D: 365 }
const MAX_CONTACTS = 20

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

export async function GET() {
  try {
    const sheets = getSheetsClient()
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "A1:J600",
    })

    const rows: string[][] = (response.data.values as string[][] | null) || []
    console.log(`[crms/contacts] Sheet returned ${rows.length} rows`)
    const due = []
    const now = new Date()

    // rows[0] is the header row — skip it (i starts at 1)
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

      // Snooze check — column J holds an ISO date string
      if (snoozeUntil && new Date(snoozeUntil) > now) continue

      const lastContacted = parseLastContacted(row[6] || "")
      const cadenceDays   = CADENCE[tier] ?? 45
      const daysSinceLast = daysSince(lastContacted)
      const daysOverdue   = Math.max(0, daysSinceLast - cadenceDays)
      const isDue         = daysSinceLast >= cadenceDays

      if (!isDue) continue

      const { hasNotes, notesStale, cleanNote } = parseNote(noteRaw)

      due.push({
        id:            `bob-${i + 1}`,
        sheetRow:      i + 1,
        name,
        phone:         normalize(phone),
        tier,
        category:      row[4] || "Agent",
        lastContact:   lastContacted ? `${daysSinceLast}d ago` : "never",
        lastContacted: row[6] || "",
        daysOverdue,
        status:        daysOverdue > 0 ? "overdue" : "due",
        notes:         cleanNote,
        hasNotes,
        notesStale,
      })
    }

    // Sort: most overdue first, then tier priority A > B > C > D
    const tierOrder: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 }
    due.sort((a, b) => {
      if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue
      return (tierOrder[a.tier] ?? 3) - (tierOrder[b.tier] ?? 3)
    })

    return NextResponse.json({
      contacts: due.slice(0, MAX_CONTACTS),
      total: due.length,
      fetchedAt: now.toISOString(),
    })
  } catch (err) {
    console.error("crms/contacts error:", err)
    return NextResponse.json({ error: "Failed to fetch contacts" }, { status: 500 })
  }
}
