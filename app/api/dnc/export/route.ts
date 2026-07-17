import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Phase 7C — Part 9, refactored 2026-07-17 (email-campaign Phase 1): export
// the DNC suppression list as a CSV matching the direct-mail vendor's column
// shape. Ryan downloads this before sending a new mailing list and
// cross-references against his upcoming send.
//
// Reads the master `suppression` table — the single unified DNC store.
// The old two-source union (dnc_list + leads.is_dnc) is obsolete: both
// sources now sync into suppression via DB triggers, so this export can't
// miss a flagged lead the way the best-effort dnc_list inserts could.
// Mail-relevant rows only: channel 'mail' or 'all'.
//
// Most rows will have sparse address fields. Primary match key for
// cross-referencing is site_address + site_city.

// Reads live DNC state — must never be edge-cached.
export const dynamic = "force-dynamic"

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

interface SuppressionRow {
  parcel_number: string | null
  name: string | null
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
  source: string
  created_at: string | null
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
      .from("suppression")
      .select(
        "parcel_number, name, site_address, site_city, site_state, site_zip, mail_address, mail_city, mail_state, mail_zip, county, reason, source, created_at"
      )
      .in("channel", ["mail", "all"])
      .order("created_at", { ascending: false })
      .returns<SuppressionRow[]>()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // A person can appear via several sources (lead_dnc row + dnc_list row).
    // Collapse rows that share a name+site_address so the vendor CSV stays
    // one-line-per-owner; rows with neither key always pass through.
    const seen = new Set<string>()
    const rows: SuppressionRow[] = []
    for (const r of data ?? []) {
      const key = `${(r.name ?? "").toLowerCase()}|${(r.site_address ?? "").toLowerCase()}`
      if (key !== "|") {
        if (seen.has(key)) continue
        seen.add(key)
      }
      rows.push(r)
    }

    if (format === "json") {
      return NextResponse.json({ rows })
    }

    const lines: string[] = []
    lines.push(COLUMNS.map(csvEscape).join(","))
    for (const row of rows) {
      lines.push(
        [
          row.parcel_number,
          row.name,
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
          row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : null,
        ]
          .map(csvEscape)
          .join(",")
      )
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
