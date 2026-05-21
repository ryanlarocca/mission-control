import { NextResponse } from "next/server"
import { getSheetsClient, SHEET_ID } from "@/lib/sheets"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const { sheetRow, notes } = await request.json()

    if (!sheetRow || typeof sheetRow !== "number") {
      return NextResponse.json({ error: "sheetRow required" }, { status: 400 })
    }
    const value = typeof notes === "string" ? notes : ""

    const sheets = getSheetsClient()

    // Preserve any [enriched: YYYY-MM-DD] staleness marker. The read
    // routes strip this prefix before the UI ever sees it, so an edited
    // note arrives here without it. Writing `value` raw would erase the
    // marker on the first manual edit — permanently breaking 90-day
    // staleness detection and delta re-enrichment for that contact.
    // Re-read the current cell and splice the marker back on.
    let finalValue = value
    if (!/^\[enriched:\s*\d{4}-\d{2}-\d{2}\]/.test(value)) {
      try {
        const cur = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: `Sheet1!I${sheetRow}`,
        })
        const existing = String(cur.data.values?.[0]?.[0] ?? "")
        const m = existing.match(/^\[enriched:\s*(\d{4}-\d{2}-\d{2})\]/)
        if (m) finalValue = `[enriched: ${m[1]}] ${value}`
      } catch (e) {
        console.warn("crms/notes: could not read cell to preserve enriched marker:", e)
      }
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Sheet1!I${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[finalValue]] },
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("crms/notes error:", err)
    return NextResponse.json({ error: "Failed to update notes" }, { status: 500 })
  }
}
