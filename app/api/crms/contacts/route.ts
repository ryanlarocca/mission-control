import { NextResponse } from "next/server"
import { execFileSync } from "child_process"
import fs from "fs"

const GOG = "/opt/homebrew/bin/gog"
const SHEET_ID = "1sJyF3aLZxaGdA4l-i8G3Vy3yZliJjekdG6B9m3ydBIQ"
const DATA_DIR = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS/comprehensive-relationship-management/data"
const SNOOZE_FILE = `${DATA_DIR}/snooze.json`

const CADENCE: Record<string, number> = { A: 30, B: 45, C: 45, D: 90 }
const MAX_CONTACTS = 20

function normalize(phone: string): string {
  const digits = String(phone).replace(/\D/g, "")
  return digits.length >= 10 ? digits.slice(-10) : digits
}

function parseLastContacted(raw: string): Date | null {
  if (!raw || raw.trim() === "") return null
  // Handles "Apr 2, 2026" format written by crms-enrich.js
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

function readSnooze(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SNOOZE_FILE, "utf8"))
  } catch {
    return {}
  }
}

function isSnoozed(phone: string, snooze: Record<string, string>): boolean {
  const until = snooze[normalize(phone)]
  if (!until) return false
  return new Date(until) > new Date()
}

export async function GET() {
  try {
    const out = execFileSync(GOG, [
      "sheets", "get", SHEET_ID, "A1:I600",
      "-a", "info@lrghomes.com", "-j", "--results-only",
    ], { encoding: "utf8", timeout: 15000 })

    const rows: string[][] = JSON.parse(out)
    const snooze = readSnooze()
    const due = []
    const now = new Date()

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      const name     = row[0] || ""
      const phone    = row[1] || ""
      const tier     = (row[7] || "C").trim().toUpperCase()
      const noteRaw  = row[8] || ""

      if (!phone || normalize(phone).length < 10) continue
      if (!name) continue
      if (isSnoozed(phone, snooze)) continue

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

    // Sort: overdue first (most overdue first), then tier priority A > B > C > D
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
