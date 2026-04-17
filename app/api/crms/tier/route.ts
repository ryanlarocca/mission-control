import { NextResponse } from "next/server"
import { getSheetsClient, SHEET_ID } from "@/lib/sheets"

export const dynamic = "force-dynamic"

const VALID_TIERS = new Set(["A", "B", "C", "D", "E"])

export async function POST(request: Request) {
  try {
    const { sheetRow, tier } = await request.json()

    if (!sheetRow || typeof sheetRow !== "number") {
      return NextResponse.json({ error: "sheetRow required" }, { status: 400 })
    }
    const t = String(tier || "").trim().toUpperCase()
    if (!VALID_TIERS.has(t)) {
      return NextResponse.json({ error: "tier must be A, B, C, D, or E" }, { status: 400 })
    }

    const sheets = getSheetsClient()
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Sheet1!H${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[t]] },
    })

    return NextResponse.json({ success: true, tier: t })
  } catch (err) {
    console.error("crms/tier error:", err)
    return NextResponse.json({ error: "Failed to update tier" }, { status: 500 })
  }
}
