import { NextResponse } from "next/server"
import { getSheetsClient, SHEET_ID } from "@/lib/sheets"

export const dynamic = "force-dynamic"

const VALID_CATEGORIES = new Set(["Agent", "Vendor", "Personal", "PM", "Investor", "Seller"])

export async function POST(request: Request) {
  try {
    const { sheetRow, category } = await request.json()

    if (!sheetRow || typeof sheetRow !== "number") {
      return NextResponse.json({ error: "sheetRow required" }, { status: 400 })
    }
    const c = String(category || "").trim()
    if (!VALID_CATEGORIES.has(c)) {
      return NextResponse.json(
        { error: "category must be Agent, Vendor, Personal, PM, Investor, or Seller" },
        { status: 400 }
      )
    }

    const sheets = getSheetsClient()
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Sheet1!E${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[c]] },
    })

    return NextResponse.json({ success: true, category: c })
  } catch (err) {
    console.error("crms/category error:", err)
    return NextResponse.json({ error: "Failed to update category" }, { status: 500 })
  }
}
