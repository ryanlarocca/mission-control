import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Phase 7C — Part 9: export the DNC suppression list as a CSV that
// matches the direct-mail vendor's column shape. Ryan downloads this
// before sending a new mailing list and cross-references against his
// upcoming send.
//
// Most rows will have sparse address fields — the dnc_list table is the
// best-effort capture of whatever the lead row carried at flag time.
// Primary match key for cross-referencing is site_address + site_city.

const COLUMNS = [
  "Parcel Number",
  "Owner Name",
  "Site Address",
  "Site City",
  "Site State",
  "Site Zip",
  "Mail Address",
  "Mail City",
  "Mail State",
  "Mail Zip",
  "County",
  "Reason",
  "Added Date",
] as const

interface DncRow {
  parcel_number: string | null
  owner_name: string | null
  site_address: string | null
  site_city: string | null
  site_state: string | null
  site_zip: string | null
  mail_address: string | null
  mail_city: string | null
  mail_state: string | null
  mail_zip: string | null
  county: string | null
  reason: string | null
  added_at: string | null
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s = String(v)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl
  const format = (url.searchParams.get("format") || "csv").toLowerCase()

  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("dnc_list")
      .select(
        "parcel_number, owner_name, site_address, site_city, site_state, site_zip, mail_address, mail_city, mail_state, mail_zip, county, reason, added_at"
      )
      .order("added_at", { ascending: false })
      .returns<DncRow[]>()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (format === "json") {
      return NextResponse.json({ rows: data ?? [] })
    }

    const lines: string[] = []
    lines.push(COLUMNS.map(csvEscape).join(","))
    for (const row of data ?? []) {
      lines.push([
        row.parcel_number,
        row.owner_name,
        row.site_address,
        row.site_city,
        row.site_state,
        row.site_zip,
        row.mail_address,
        row.mail_city,
        row.mail_state,
        row.mail_zip,
        row.county,
        row.reason,
        row.added_at ? new Date(row.added_at).toISOString().slice(0, 10) : null,
      ].map(csvEscape).join(","))
    }
    const csv = lines.join("\n")
    const today = new Date().toISOString().slice(0, 10)

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dnc-list-${today}.csv"`,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[dnc:export] threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
