import { NextResponse } from "next/server"
import { execSync } from "child_process"
import { mockListings, mockContacts } from "@/lib/mockData"

export async function GET() {
  let listings = mockListings

  // Try to pull real data via gog sheets CLI
  try {
    const sheetId = "17JwqZ6wmQ1CNuf_Bf8T9fy1KE3sipagV77zefFKpEio"
    const output = execSync(`gog sheets read ${sheetId}`, { timeout: 8000 }).toString()
    const rows = JSON.parse(output)
    // Filter score >= 7.0 and map to Listing shape
    const real = rows
      .filter((r: Record<string, string>) => parseFloat(r.score) >= 7.0)
      .map((r: Record<string, string>, i: number) => ({
        id: String(i),
        address: r.address || r.Address || "",
        price: parseInt(r.price || r.Price || "0"),
        score: parseFloat(r.score || r.Score || "0"),
        status: (r.status || r.Status || "new").toLowerCase(),
        daysOnMarket: parseInt(r.dom || r.DOM || "0"),
        beds: parseInt(r.beds || r.Beds || "0"),
        baths: parseFloat(r.baths || r.Baths || "0"),
        sqft: parseInt(r.sqft || r.Sqft || "0"),
        url: r.url || r.URL || "",
        notes: r.notes || r.Notes || "",
        lastContact: r.lastContact || r.last_contact || "",
      }))
    if (real.length > 0) listings = real
  } catch {
    // Fall through to mock data
  }

  return NextResponse.json({ listings, contacts: mockContacts })
}
