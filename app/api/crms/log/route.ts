import { NextResponse } from "next/server"
import { getSheetsClient, SHEET_ID } from "@/lib/sheets"

function normalize(phone: string): string {
  return String(phone).replace(/\D/g, "").slice(-10)
}

export async function POST(request: Request) {
  try {
    const { name, phone, sheetRow, modality, message, action, tier, category } = await request.json()

    const timestamp = new Date().toISOString()
    const norm = normalize(phone)
    const sheets = getSheetsClient()

    let logAppended = true
    let lastContactedWritten: boolean | null = null
    let snoozeWritten: boolean | null = null

    // Append to the "Log" tab in the BoB sheet
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Log!A1",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[timestamp, name, norm, sheetRow, modality, action, tier, category, message]],
        },
      })
    } catch (e) {
      console.error("Failed to append to Log tab:", e)
      logAppended = false
    }

    if (action === "sent") {
      // Update column G (LastContacted) in BoB Sheet1 — CRITICAL for cadence
      const today = new Date().toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      })
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Sheet1!G${sheetRow}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[today]] },
        })
        lastContactedWritten = true
      } catch (e) {
        console.error("Failed to update LastContacted in BoB:", e)
        lastContactedWritten = false
      }
    }

    if (action === "skipped") {
      // Write snooze expiry (24h from now) to column J of the contact's row
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Sheet1!J${sheetRow}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[until]] },
        })
        snoozeWritten = true
      } catch (e) {
        console.error("Failed to write snooze to sheet:", e)
        snoozeWritten = false
      }
    }

    // If the action was "sent" but we failed to write LastContacted, the
    // contact will keep re-appearing in the queue. Return 500 so the client
    // can surface the failure to the user.
    if (action === "sent" && lastContactedWritten === false) {
      return NextResponse.json(
        { ok: false, logAppended, lastContactedWritten, error: "Failed to write LastContacted to sheet" },
        { status: 500 }
      )
    }

    return NextResponse.json({ ok: true, logAppended, lastContactedWritten, snoozeWritten })
  } catch (err) {
    console.error("crms/log error:", err)
    return NextResponse.json({ error: "Failed to log action" }, { status: 500 })
  }
}
