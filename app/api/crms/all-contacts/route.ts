import { NextResponse } from "next/server"
import { getSheetsClient, SHEET_ID } from "@/lib/sheets"
import {
  type RelationshipCategory as ContactType,
  normalizeCategory,
} from "@/lib/crms"

// Full BoB-sheet dump for the Relationships-tab search box. Unlike
// /api/crms/contacts (which returns only today's cadence-due queue, capped
// per type), this returns EVERY usable contact so Ryan can look anyone up —
// including tier E and snoozed contacts, which never surface in the queue.
export const dynamic = "force-dynamic"
export const revalidate = 0

const CADENCE: Record<string, number> = { A: 30, B: 45, C: 60, D: 365 }

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

interface Contact {
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

export async function GET() {
  try {
    const sheets = getSheetsClient()
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "A1:J2000",
    })
    const rows: string[][] = (response.data.values as string[][] | null) || []

    const contacts: Contact[] = []
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      const name  = row[0] || ""
      const phone = row[1] || ""
      if (!phone || normalize(phone).length < 10) continue
      if (isBadName(name)) continue

      const tier = (row[7] || "C").trim().toUpperCase()
      const type = normalizeCategory(row[4] || "Agent")
      const { hasNotes, notesStale, cleanNote } = parseNote(row[8] || "")
      const lastContacted = parseLastContacted(row[6] || "")
      const daysSinceLast = daysSince(lastContacted)
      const cadenceDays   = CADENCE[tier] ?? 45
      const daysOverdue   = Math.max(0, daysSinceLast - cadenceDays)

      contacts.push({
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
    }

    contacts.sort((a, b) => a.name.localeCompare(b.name))

    return NextResponse.json({ contacts, total: contacts.length })
  } catch (err) {
    console.error("crms/all-contacts error:", err)
    return NextResponse.json({ error: "Failed to fetch contacts" }, { status: 500 })
  }
}
