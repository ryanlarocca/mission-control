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
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Sheet1!I${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[value]] },
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("crms/notes error:", err)
    return NextResponse.json({ error: "Failed to update notes" }, { status: 500 })
  }
}
