import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Phase 7C — Part 9: export the DNC suppression list as a CSV that
// matches the direct-mail vendor's column shape. Ryan downloads this
// before sending a new mailing list and cross-references against his
// upcoming send.
//
// Two sources, unioned: (1) the dnc_list table — rich parcel/site/mail
// columns; (2) leads.is_dnc — the AUTHORITATIVE flag. dnc_list inserts
// are best-effort and silently swallow failures, so a flagged lead can
// be missing from dnc_list entirely. Exporting dnc_list alone would let
// that owner get mailed again — the whole point this export prevents.
// So every is_dnc lead not already in dnc_list gets a synthesized row.
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
  source_lead_id?: string | null
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

    // Source 1 — dnc_list: the rich-column rows. Newest-first so a lead
    // with several rows (DNC re-clicks) keeps only its most recent.
    const { data: dncListData, error: dncErr } = await sb
      .from("dnc_list")
      .select(
        "parcel_number, owner_name, site_address, site_city, site_state, site_zip, mail_address, mail_city, mail_state, mail_zip, county, reason, added_at, source_lead_id"
      )
      .order("added_at", { ascending: false })
      .returns<DncRow[]>()
    if (dncErr) {
      return NextResponse.json({ error: dncErr.message }, { status: 500 })
    }

    // Source 2 — leads.is_dnc: the authoritative flag. Any flagged lead
    // missing from dnc_list gets a synthesized sparse row below.
    const { data: dncLeadsData, error: leadsErr } = await sb
      .from("leads")
      .select("id, name, property_address")
      .eq("is_dnc", true)
    if (leadsErr) {
      return NextResponse.json({ error: leadsErr.message }, { status: 500 })
    }

    const rows: DncRow[] = []
    const coveredLeadIds = new Set<string>()
    for (const r of dncListData ?? []) {
      const lid = r.source_lead_id ?? null
      if (lid) {
        if (coveredLeadIds.has(lid)) continue // keep only the newest row per lead
        coveredLeadIds.add(lid)
      }
      rows.push(r)
    }
    for (const lead of dncLeadsData ?? []) {
      if (coveredLeadIds.has(lead.id)) continue
      rows.push({
        parcel_number: null,
        owner_name: lead.name ?? null,
        site_address: lead.property_address ?? null,
        site_city: null, site_state: null, site_zip: null,
        mail_address: null, mail_city: null, mail_state: null, mail_zip: null,
        county: null,
        reason: "is_dnc flag (no dnc_list row)",
        added_at: null,
      })
    }

    if (format === "json") {
      return NextResponse.json({ rows })
    }

    const lines: string[] = []
    lines.push(COLUMNS.map(csvEscape).join(","))
    for (const row of rows) {
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
