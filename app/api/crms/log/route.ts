import { NextResponse } from "next/server"
import { execFileSync } from "child_process"
import fs from "fs"

const GOG = "/opt/homebrew/bin/gog"
const SHEET_ID = "1sJyF3aLZxaGdA4l-i8G3Vy3yZliJjekdG6B9m3ydBIQ"
const DATA_DIR = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS/comprehensive-relationship-management/data"
const LOG_FILE = `${DATA_DIR}/outreach_log.json`
const SNOOZE_FILE = `${DATA_DIR}/snooze.json`

function normalize(phone: string): string {
  return String(phone).replace(/\D/g, "").slice(-10)
}

function readLog(): object[] {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"))
  } catch {
    return []
  }
}

function readSnooze(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SNOOZE_FILE, "utf8"))
  } catch {
    return {}
  }
}

export async function POST(request: Request) {
  try {
    const { name, phone, sheetRow, modality, message, action, tier, category } = await request.json()

    const timestamp = new Date().toISOString()
    const norm = normalize(phone)

    // Append to outreach log
    const log = readLog()
    log.push({ name, phone: norm, sheetRow, modality, message, action, tier, category, timestamp })
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2))

    if (action === "sent") {
      // Update column G (LastContacted) in BoB
      const today = new Date().toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      })
      try {
        execFileSync(GOG, [
          "sheets", "update", SHEET_ID, `Sheet1!G${sheetRow}`,
          "--values-json", JSON.stringify([[today]]),
          "-a", "info@lrghomes.com",
        ], { encoding: "utf8", timeout: 10000 })
      } catch (e) {
        console.error("Failed to update LastContacted in BoB:", e)
        // Don't fail the whole request — log was already written
      }
    }

    if (action === "skipped") {
      // Snooze for 24 hours
      const snooze = readSnooze()
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      snooze[norm] = until
      fs.writeFileSync(SNOOZE_FILE, JSON.stringify(snooze, null, 2))
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("crms/log error:", err)
    return NextResponse.json({ error: "Failed to log action" }, { status: 500 })
  }
}
