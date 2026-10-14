// NOO Q4 2026 vendor re-pull (v2) join — the pure half of
// scripts/join-mail-records-v2.mjs (brief BRIEF_NOO_Q4_VENDOR_V2_JOIN_2026-10-14 §2).
//
// Everything here runs without a database so the unit tests
// (tests/mail-records-vendor-v2.unit.test.ts) can exercise the header check,
// the row → update mapping, the APN matcher and the report on the committed
// fixture. The script owns argv, file I/O, Supabase and exit codes.
//
// Invariants (Ryan 2026-10-14): the join writes ONLY the v2 columns below plus
// `id` / `campaign_id`. It never touches sale_date, owner_name, arm, batch,
// piece, raw or the match-key columns — the v2 Sale Date / Owner Name are
// stored beside the originals as vendor_v2_sale_date / vendor_v2_owner_name.
import { normApn } from "./mailMatch.ts"

export type V2Kind = "text" | "date" | "bool" | "numeric" | "int" | "exemption"

export interface V2ColumnSpec {
  /** mail_records column written by the join. */
  column: string
  /** Header in the vendor v2 file. */
  source: string
  kind: V2Kind
}

/** The 20 new vendor columns + the two v2 copies of existing fields, in §2a order. */
export const V2_COLUMNS: readonly V2ColumnSpec[] = [
  { column: "deed_type", source: "Deed Type", kind: "text" },
  { column: "non_dollar_sale_date", source: "Non$ Sale Date", kind: "date" },
  { column: "non_dollar_doc_number", source: "Non$ Document Number", kind: "text" },
  { column: "tax_delinquent", source: "Tax Delinquent", kind: "bool" },
  { column: "tax_delinquent_years", source: "Tax Delinquent Year(s)", kind: "text" },
  { column: "tax_amount", source: "Tax Amount", kind: "numeric" },
  { column: "tax_exemption_code", source: "Tax Exemption Code", kind: "text" },
  { column: "homeowner_exemption", source: "Tax Exemption Code", kind: "exemption" },
  { column: "loan_amount", source: "Loan Amount", kind: "numeric" },
  { column: "loan_amount_2nd", source: "Loan Amount 2nd", kind: "numeric" },
  { column: "loan_type", source: "Loan Type", kind: "text" },
  { column: "owner_type_vendor", source: "Owner Type", kind: "text" },
  { column: "assessed_improvement_value", source: "Assessed Improvement Value", kind: "numeric" },
  { column: "total_assessed_value", source: "Total Assessed Value", kind: "numeric" },
  { column: "total_market_value", source: "Total Market Value", kind: "numeric" },
  { column: "distressed_status", source: "Distressed Status", kind: "text" },
  { column: "prior_sale_date", source: "Prior Sale Date", kind: "date" },
  { column: "prior_sales_price", source: "Prior Sales Price", kind: "numeric" },
  { column: "prior_buyer1_last", source: "Prior Buyer1 Last Name", kind: "text" },
  { column: "effective_year_built", source: "Effective Year Built", kind: "int" },
  { column: "air_conditioning", source: "Air Conditioning", kind: "text" },
  { column: "vendor_v2_sale_date", source: "Sale Date", kind: "date" },
  { column: "vendor_v2_owner_name", source: "Owner Name", kind: "text" },
]

/** Every header the join needs; hard-fail when one is missing. */
export const REQUIRED_HEADERS: readonly string[] = Array.from(
  new Set(["Parcel Number", "County", "Owner Name", "Sale Date", ...V2_COLUMNS.map(c => c.source)])
)

/** The full set of columns a commit writes (besides id + campaign_id). */
export const WRITTEN_COLUMNS: readonly string[] = [
  ...V2_COLUMNS.map(c => c.column),
  "vendor_v2_at",
  "vendor_v2_file",
  "raw_v2",
]

/** Columns the join must never write, whatever the input looks like. */
export const PROTECTED_COLUMNS: readonly string[] = [
  "sale_date", "owner_name", "arm", "batch", "piece", "raw", "record_id", "is_seed",
  "parcel_number", "parcels", "parcel_count",
  "site_street_norm", "site_city_norm", "mail_line_norm", "mail_city_norm", "owner_surname_norm", "owner_name_norm",
]

/**
 * Identity columns the commit echoes back unchanged beside the v2 columns.
 * Postgres checks NOT NULL on the proposed row BEFORE `ON CONFLICT (id) DO
 * UPDATE` arbitration, so an upsert payload that omits the NOT NULL columns
 * record_id / arm fails even though the row exists. The script copies both
 * from the row it just loaded; the guard in the script asserts they are
 * identical, so they are never a write in practice.
 */
export const IDENTITY_ECHO_COLUMNS: readonly string[] = ["record_id", "arm"]

/** Report columns whose value distribution is printed. */
export const DISTRIBUTION_COLUMNS: readonly string[] = [
  "deed_type", "owner_type_vendor", "tax_delinquent", "homeowner_exemption", "loan_type", "distressed_status", "air_conditioning",
]

/** The 40 Oct 2 vendor columns the join reads only into raw_v2 — known, not "extra". */
export const ORIGINAL_HEADERS: readonly string[] = [
  "Full Site Address", "Site Address", "Site Address City", "Site Address State", "Site Address Zip", "Owner Occupied",
  "Full Mail Address", "Mail Address", "Mail Address City", "Mail Address State", "Mail Address Zip",
  "Assessed Land Value", "Assessed Improve Percent", "Use Code", "Use Code Description", "Zoning", "Year Built", "Building Area",
  "Number of Units", "Rooms", "Bedrooms", "Bathrooms", "Lot Area Acres", "Lot Area SQFT", "Number of Stories", "Pool",
  "Garage Number of Cars", "Number of Building", "Garage Type", "Sales Price", "Owner Name2",
  "Owner1 First Name", "Owner1 Last Name", "Owner2 First Name", "Owner2 Last Name",
  "Prior Seller1 First Name", "Prior Seller1 Last Name", "Seller1 First Name", "Seller1 Last Name",
]

export interface HeaderCheck {
  missing: string[]
  extra: string[]
}

/** Required headers absent → `missing` (fatal); headers that are neither required nor one of the 40 original vendor columns → `extra` (warn only). */
export function checkHeaders(header: readonly string[]): HeaderCheck {
  const have = new Set(header.map(h => h.trim()))
  const missing = REQUIRED_HEADERS.filter(h => !have.has(h))
  const known = new Set([...REQUIRED_HEADERS, ...ORIGINAL_HEADERS])
  const extra = header.map(h => h.trim()).filter(h => !known.has(h))
  return { missing, extra }
}

// ---- cell parsers -----------------------------------------------------------

export function parseText(v: unknown): string | null {
  const s = String(v ?? "").trim()
  return s === "" ? null : s
}

/** MM/DD/YYYY (1–2 digit month/day tolerated) → YYYY-MM-DD; anything else → null. */
export function parseDate(v: unknown): string | null {
  const m = String(v ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const mm = Number(m[1]), dd = Number(m[2])
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  return `${m[3]}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`
}

/** `Y`/`YES`→true, `N`/`NO`→false, blank or anything else → null. Case-insensitive. */
export function parseYN(v: unknown): boolean | null {
  const s = String(v ?? "").trim().toUpperCase()
  if (s === "Y" || s === "YES") return true
  if (s === "N" || s === "NO") return false
  return null
}

/** Plain number; `$` and thousands separators tolerated. Blank / non-numeric → null. */
export function parseNumeric(v: unknown): number | null {
  const s = String(v ?? "").trim().replace(/[$,]/g, "")
  if (s === "") return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function parseInt_(v: unknown): number | null {
  const n = parseNumeric(v)
  return n == null ? null : Math.round(n)
}

/** `Yes (H)` → true, `None` → false, blank → null. Only the `Yes` prefix matters. */
export function parseExemption(v: unknown): boolean | null {
  const s = String(v ?? "").trim()
  if (s === "") return null
  return /^yes/i.test(s)
}

function parseCell(kind: V2Kind, v: unknown): string | number | boolean | null {
  switch (kind) {
    case "text": return parseText(v)
    case "date": return parseDate(v)
    case "bool": return parseYN(v)
    case "numeric": return parseNumeric(v)
    case "int": return parseInt_(v)
    case "exemption": return parseExemption(v)
  }
}

export type V2Update = Record<string, string | number | boolean | null | Record<string, string>>

/**
 * One vendor row → the mail_records update (v2 columns only). `raw_v2` is the
 * whole row verbatim (header → string). The caller adds `id` + `campaign_id`.
 */
export function rowToUpdate(row: Record<string, string>, file: string, now: string): V2Update {
  const out: V2Update = {}
  for (const c of V2_COLUMNS) out[c.column] = parseCell(c.kind, row[c.source])
  out.vendor_v2_at = now
  out.vendor_v2_file = file
  out.raw_v2 = { ...row }
  for (const p of PROTECTED_COLUMNS) if (p in out) throw new Error(`join would write protected column ${p}`)
  return out
}

// ---- matcher ----------------------------------------------------------------

/** County name key: letters only, lowercase ("Santa Clara" → "santaclara"). */
export function normCounty(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z]/g, "")
}

/**
 * Index key. APNs are only unique WITHIN a county: Santa Clara 015-06-101 and
 * Santa Cruz 015-061-01 both normalize to 01506101 (hit 2026-10-14), so the
 * key is county + APN. mail_records.county carries the same full county name
 * as the vendor "County" column.
 */
export function apnKey(county: unknown, apn: string): string {
  return `${normCounty(county)}|${apn}`
}

export interface V2Row {
  /** normApn(Parcel Number) */
  apn: string
  /** normCounty(County) */
  county: string
  /** basename of the source file */
  file: string
  row: Record<string, string>
}

export interface V2Index {
  /** apnKey(county, apn) → row */
  byApn: Map<string, V2Row>
  /** rows whose Parcel Number normalizes to "" — never matchable, reported */
  blankApn: number
}

/**
 * Index parsed vendor rows by county + normalized APN. Throws on a duplicate
 * key (within or across files) — the county files are disjoint by design and
 * a duplicate would make the join ambiguous.
 */
export function buildV2Index(files: { file: string; rows: Record<string, string>[] }[]): V2Index {
  const byApn = new Map<string, V2Row>()
  let blankApn = 0
  for (const f of files) {
    for (const row of f.rows) {
      const apn = normApn(row["Parcel Number"])
      if (!apn) { blankApn++; continue }
      const county = normCounty(row["County"])
      const key = apnKey(county, apn)
      const prev = byApn.get(key)
      if (prev) throw new Error(`duplicate normalized APN ${apn} in county "${row["County"]}" (${prev.file} and ${f.file})`)
      byApn.set(key, { apn, county, file: f.file, row })
    }
  }
  return { byApn, blankApn }
}

/** The mail_records columns the join reads. */
export const MAIL_RECORD_JOIN_COLUMNS = "id, record_id, arm, county, parcel_number, parcels, parcel_count, sale_date, owner_name, is_seed"

export interface MailRecordJoinRow {
  id: string
  record_id: string
  arm: string
  county: string | null
  parcel_number: string | null
  parcels: string | null
  parcel_count: number | null
  sale_date: string | null
  owner_name: string | null
  is_seed: boolean
}

export type MatchVia = "primary" | "secondary_parcel"

export interface Matched {
  record: MailRecordJoinRow
  v2: V2Row
  via: MatchVia
}

export interface MatchResult {
  matched: Matched[]
  /** non-seed rows with a parcel that hit nothing */
  unmatched: MailRecordJoinRow[]
  /** is_seed, or blank parcel_number — skipped, never counted as unmatched */
  seeds: MailRecordJoinRow[]
  /** normalized v2 APNs that no mail_records row claimed */
  v2NotInRecords: number
}

/** Pipe-separated `parcels` → normalized APNs, in order, blanks dropped. */
export function splitParcels(parcels: string | null | undefined): string[] {
  return String(parcels ?? "").split("|").map(normApn).filter(Boolean)
}

/**
 * Primary key = county + normApn(parcel_number). Miss → walk `parcels` in
 * order (same county) and take the first hit (matched_via_secondary_parcel).
 * Seeds and blank parcels are skipped; a record with no county can never
 * match (reported as unmatched). One v2 row may serve several records (shared parcel); every
 * record is updated.
 */
export function matchRecords(records: readonly MailRecordJoinRow[], index: V2Index): MatchResult {
  const matched: Matched[] = []
  const unmatched: MailRecordJoinRow[] = []
  const seeds: MailRecordJoinRow[] = []
  const claimed = new Set<string>()
  for (const r of records) {
    const primary = normApn(r.parcel_number)
    if (r.is_seed || !primary) { seeds.push(r); continue }
    const county = normCounty(r.county)
    let hit = index.byApn.get(apnKey(county, primary))
    let via: MatchVia = "primary"
    if (!hit) {
      for (const apn of splitParcels(r.parcels)) {
        const h = index.byApn.get(apnKey(county, apn))
        if (h) { hit = h; via = "secondary_parcel"; break }
      }
    }
    if (hit) { matched.push({ record: r, v2: hit, via }); claimed.add(apnKey(hit.county, hit.apn)) }
    else unmatched.push(r)
  }
  return { matched, unmatched, seeds, v2NotInRecords: index.byApn.size - claimed.size }
}

// ---- report -----------------------------------------------------------------

export interface SaleDateDrift {
  record_id: string
  sale_date: string | null
  vendor_v2_sale_date: string | null
}

export interface JoinReport {
  rowsPerFile: Record<string, number>
  blankApnRows: number
  recordsTotal: number
  matched: number
  matchedViaSecondaryParcel: number
  unmatchedRecordIds: string[]
  seedsSkipped: number
  seedRecordIds: string[]
  v2NotInRecords: number
  /** column → share of matched rows with a non-null value (0–1) */
  fillRate: Record<string, number>
  /** column → value → count (null shown as "null") */
  distributions: Record<string, Record<string, number>>
  saleDateDrift: SaleDateDrift[]
  ownerNameChanged: number
}

/** Everything the dry run prints, computed from the match result + the per-row updates. */
export function buildReport(
  files: { file: string; rows: Record<string, string>[] }[],
  index: V2Index,
  records: readonly MailRecordJoinRow[],
  match: MatchResult,
  updates: readonly V2Update[]
): JoinReport {
  const rowsPerFile: Record<string, number> = {}
  for (const f of files) rowsPerFile[f.file] = f.rows.length
  const n = match.matched.length
  const fillRate: Record<string, number> = {}
  for (const c of V2_COLUMNS) {
    const filled = updates.filter(u => u[c.column] != null).length
    fillRate[c.column] = n ? filled / n : 0
  }
  const distributions: Record<string, Record<string, number>> = {}
  for (const col of DISTRIBUTION_COLUMNS) {
    const d: Record<string, number> = {}
    for (const u of updates) { const k = u[col] == null ? "null" : String(u[col]); d[k] = (d[k] ?? 0) + 1 }
    distributions[col] = d
  }
  const saleDateDrift: SaleDateDrift[] = []
  let ownerNameChanged = 0
  match.matched.forEach((m, i) => {
    const u = updates[i]
    const v2Sale = (u.vendor_v2_sale_date as string | null) ?? null
    if (v2Sale !== (m.record.sale_date ?? null)) saleDateDrift.push({ record_id: m.record.record_id, sale_date: m.record.sale_date ?? null, vendor_v2_sale_date: v2Sale })
    const v2Owner = (u.vendor_v2_owner_name as string | null) ?? null
    if (v2Owner !== parseText(m.record.owner_name)) ownerNameChanged++
  })
  return {
    rowsPerFile,
    blankApnRows: index.blankApn,
    recordsTotal: records.length,
    matched: n,
    matchedViaSecondaryParcel: match.matched.filter(m => m.via === "secondary_parcel").length,
    unmatchedRecordIds: match.unmatched.map(r => r.record_id),
    seedsSkipped: match.seeds.length,
    seedRecordIds: match.seeds.map(r => r.record_id),
    v2NotInRecords: match.v2NotInRecords,
    fillRate,
    distributions,
    saleDateDrift,
    ownerNameChanged,
  }
}

/** Human-readable dump of the report (the script prints this before any write). */
export function formatReport(r: JoinReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const lines: string[] = []
  lines.push("files:")
  for (const [f, n] of Object.entries(r.rowsPerFile)) lines.push(`  ${f}: ${n} rows`)
  if (r.blankApnRows) lines.push(`  ⚠ ${r.blankApnRows} vendor rows with a blank Parcel Number (unmatchable)`)
  lines.push(`mail_records rows for campaign: ${r.recordsTotal}`)
  lines.push(`matched: ${r.matched} (via secondary parcel: ${r.matchedViaSecondaryParcel})`)
  lines.push(`unmatched: ${r.unmatchedRecordIds.length}${r.unmatchedRecordIds.length ? " — " + r.unmatchedRecordIds.join(", ") : ""}`)
  lines.push(`seeds / blank parcel skipped: ${r.seedsSkipped}${r.seedRecordIds.length ? " — " + r.seedRecordIds.join(", ") : ""}`)
  lines.push(`v2 APNs not present in mail_records: ${r.v2NotInRecords}`)
  lines.push("fill rate on matched rows:")
  for (const [col, rate] of Object.entries(r.fillRate)) lines.push(`  ${col.padEnd(28)} ${pct(rate)}`)
  lines.push("distributions:")
  for (const [col, d] of Object.entries(r.distributions)) {
    const parts = Object.entries(d).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`)
    lines.push(`  ${col}: ${parts.join(" · ")}`)
  }
  lines.push(`vendor_v2_sale_date ≠ sale_date: ${r.saleDateDrift.length}`)
  for (const d of r.saleDateDrift) lines.push(`  ${d.record_id}: ${d.sale_date ?? "null"} → ${d.vendor_v2_sale_date ?? "null"}`)
  lines.push(`vendor_v2_owner_name ≠ owner_name: ${r.ownerNameChanged}`)
  return lines.join("\n")
}
