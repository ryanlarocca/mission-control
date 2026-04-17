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
      // Non-fatal — continue
    }

    if (action === "sent") {
      // Update column G (LastContacted) in BoB Sheet1
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
      } catch (e) {
        console.error("Failed to update LastContacted in BoB:", e)
        // Non-fatal — log was already written
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
      } catch (e) {
        console.error("Failed to write snooze to sheet:", e)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("crms/log error:", err)
    return NextResponse.json({ error: "Failed to log action" }, { status: 500 })
  }
}
