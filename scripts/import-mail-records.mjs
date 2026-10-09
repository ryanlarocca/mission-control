#!/usr/bin/env node
// Import a direct-mail campaign file (list build Step 12 `mission_control_import.csv`)
// into mail_records. Dry-run by default; --commit writes.
//
//   node --env-file=.env.local scripts/import-mail-records.mjs --campaign <uuid> --file <csv> [--commit] [--expect <reconciliation.json>]
//
// Reconciliation (hard-fails on any mismatch):
//   rows in file == rows in table for the campaign after import
//   per-arm and per-batch counts in file == counts in table
//   optional --expect: the Step 12 reconciliation table {arm: {batch: n}} must equal the file
// Side effect on --commit: campaigns.pieces_sent = mailed non-seed rows (arms A/B/C).
// Upsert key (campaign_id, record_id) — re-running is safe.
import fs from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { normStreet, normCity, normSurname, normName } from "../lib/mailMatch.ts"

const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }
const campaign = arg("--campaign"), file = arg("--file"), expectPath = arg("--expect"), commit = process.argv.includes("--commit")
if (!campaign || !file) { console.error("usage: --campaign <uuid> --file <csv> [--commit] [--expect <json>]"); process.exit(1) }

// Quote-aware CSV parser (RFC 4180: "" escapes a quote, newlines allowed inside quotes).
function parseCsv(text) {
  const rows = []; let row = [], field = "", inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += ch
    } else if (ch === '"') inQ = true
    else if (ch === ",") { row.push(field); field = "" }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = "" }
    else field += ch
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row) }
  return rows
}

// Explicit header → column map. The import file carries every vendor column
// (stored verbatim in `raw`) plus the list-build tags; anything in this map
// is also lifted into a typed column.
const MAP = {
  record_id: "record_id", arm: "arm", batch: "batch", is_seed: "is_seed",
  "Parcel Number": "parcel_number", "Owner Name": "owner_name", "Owner Name2": "owner_name2",
  "Owner1 First Name": "owner1_first", "Owner1 Last Name": "owner1_last", "Owner2 First Name": "owner2_first", "Owner2 Last Name": "owner2_last",
  "Site Address": "site_address", "Site Address City": "site_city", "Site Address Zip": "site_zip",
  "Full Mail Address": "mail_address", "Mail Address City": "mail_city", "Mail Address State": "mail_state", "Mail Address Zip": "mail_zip",
  source_county: "county",
  tenure_years: "tenure_years", tenure_bucket: "tenure_bucket", imp_tercile: "imp_tercile", year_built_bucket: "year_built_bucket",
  owner_type: "owner_type", po_box: "po_box", managed: "managed", out_of_county: "out_of_county", parcel_count: "parcel_count", parcels: "parcels",
  estate_language: "estate_language", family_transfer: "family_transfer", out_of_state: "out_of_state", multi_parcel_personal: "multi_parcel_personal", any_signal: "any_signal",
  "Sale Date": "sale_date", "Sales Price": "sales_price", "Year Built": "year_built", "Assessed Improve Percent": "assessed_improve_pct",
}
const REQUIRED = ["record_id", "arm", "batch", "is_seed", "Parcel Number", "Owner Name", "Site Address", "Site Address City", "Site Address Zip", "Full Mail Address", "Mail Address City", "Mail Address State", "Mail Address Zip", "source_county"]
const BOOL = new Set(["is_seed", "po_box", "managed", "out_of_county", "estate_language", "family_transfer", "out_of_state", "multi_parcel_personal", "any_signal"])
const INT = new Set(["batch", "parcel_count", "year_built"])
const NUM = new Set(["tenure_years", "sales_price", "assessed_improve_pct"])
const bool = (v) => /^(true|t|1|y|yes)$/i.test(String(v).trim())
const num = (v) => { const s = String(v).trim(); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null }
const date = (v) => { const m = String(v).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[1]}-${m[2]}` : null }

const text = fs.readFileSync(file, "utf8")
const parsed = parseCsv(text)
const hdr = parsed[0].map((h) => h.trim())
const missing = REQUIRED.filter((h) => !hdr.includes(h))
if (missing.length) { console.error("Missing required headers:", missing); process.exit(1) }
const body = parsed.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""))
const bad = body.filter((r) => r.length !== hdr.length)
if (bad.length) { console.error(`${bad.length} rows have the wrong field count (first: ${JSON.stringify(bad[0]).slice(0, 200)})`); process.exit(1) }

const records = body.map((r) => {
  const raw = Object.fromEntries(hdr.map((h, i) => [h, r[i]]))
  const out = { campaign_id: campaign, raw }
  for (const [h, col] of Object.entries(MAP)) {
    if (!(h in raw)) continue
    const v = raw[h]
    if (BOOL.has(col)) out[col] = bool(v)
    else if (INT.has(col)) { const n = num(v); out[col] = n == null ? null : Math.round(n) }
    else if (NUM.has(col)) out[col] = num(v)
    else if (col === "sale_date") out[col] = date(v)
    else out[col] = String(v).trim() === "" ? null : String(v).trim()
  }
  out.site_street_norm = normStreet(raw["Site Address"])
  out.site_city_norm = normCity(raw["Site Address City"])
  out.mail_line_norm = normStreet(raw["Full Mail Address"])
  out.mail_city_norm = normCity(raw["Mail Address City"])
  out.owner_surname_norm = normSurname(raw["Owner1 Last Name"] || raw["Owner Name"])
  out.owner_name_norm = normName(raw["Owner Name"])
  return out
})

const ARMS = new Set(["A", "B", "C", "none", "seed"])
const badArm = records.filter((r) => !ARMS.has(r.arm))
if (badArm.length) { console.error(`${badArm.length} rows with an arm outside A/B/C/none/seed, e.g. ${badArm[0].arm}`); process.exit(1) }
const dupIds = records.map((r) => r.record_id).filter((v, i, a) => a.indexOf(v) !== i)
if (dupIds.length) { console.error("Duplicate record_id in file:", dupIds.slice(0, 5)); process.exit(1) }

const tally = (rows) => { const t = {}; for (const r of rows) { (t[r.arm] ??= {})[r.batch ?? "null"] = ((t[r.arm] ??= {})[r.batch ?? "null"] ?? 0) + 1 } return t }
const fileTally = tally(records)
const mailed = records.filter((r) => !r.is_seed && ["A", "B", "C"].includes(r.arm)).length
console.log(`file: ${records.length} rows · mailed non-seed ${mailed} · seeds ${records.filter((r) => r.is_seed).length}`)
console.log("by arm × batch:", JSON.stringify(fileTally))
if (expectPath) {
  const expect = JSON.parse(fs.readFileSync(expectPath, "utf8"))
  if (JSON.stringify(expect) !== JSON.stringify(fileTally)) { console.error("RECONCILE FAIL: --expect does not match the file\nexpected", JSON.stringify(expect)); process.exit(2) }
  console.log("✓ file matches --expect reconciliation table")
}
if (!commit) { console.log("dry run — add --commit to write"); process.exit(0) }

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
for (let i = 0; i < records.length; i += 500) {
  const { error } = await sb.from("mail_records").upsert(records.slice(i, i + 500), { onConflict: "campaign_id,record_id" })
  if (error) { console.error(`upsert failed at ${i}: ${error.message}`); process.exit(3) }
  process.stdout.write(`\r  upserted ${Math.min(i + 500, records.length)}/${records.length}`)
}
console.log()
const dbRows = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("mail_records").select("record_id, arm, batch, is_seed").eq("campaign_id", campaign).range(from, from + 999)
  if (error) { console.error(error.message); process.exit(3) }
  dbRows.push(...data); if (data.length < 1000) break
}
const dbTally = tally(dbRows)
const ok = dbRows.length === records.length && JSON.stringify(dbTally) === JSON.stringify(fileTally)
console.log(`table: ${dbRows.length} rows for this campaign · by arm × batch ${JSON.stringify(dbTally)}`)
if (!ok) { console.error("RECONCILE FAIL: table does not equal file"); process.exit(2) }
const { error: cErr } = await sb.from("campaigns").update({ pieces_sent: mailed }).eq("id", campaign)
if (cErr) { console.error("pieces_sent update failed:", cErr.message); process.exit(3) }
console.log(`✓ reconciled · campaigns.pieces_sent = ${mailed}`)
