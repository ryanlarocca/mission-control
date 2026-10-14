#!/usr/bin/env node
// Join Dominic's re-pulled county files (vendor v2, 2026-10-13/14) onto
// mail_records by normalized APN and store the 20 new columns + the v2
// Sale Date / Owner Name beside the originals. Dry-run by default; --commit writes.
//
//   node --env-file=.env.local scripts/join-mail-records-v2.mjs --campaign <uuid> --file <csv> [--file <csv> …] [--commit]
//
// Offline dry run (no Supabase): --records-json <file> supplies the campaign's
// mail_records rows (array of {id, record_id, arm, parcel_number, parcels,
// parcel_count, sale_date, owner_name, is_seed}) instead of loading them.
//
// Writes ONLY the v2 columns + id + campaign_id (upsert on id, batches of
// 500), echoing record_id + arm unchanged because they are NOT NULL and the
// upsert's INSERT half is validated before the conflict is resolved. Never
// sale_date, owner_name, batch, piece, raw or the match keys.
// Afterwards re-reads the campaign and asserts: vendor_v2_at set == matched
// count, row count unchanged, sale_date unchanged on a 200-row sample.
// Exit 1 usage / input error · 2 reconciliation failure · 3 Supabase error.
// Idempotent — re-running overwrites the same v2 columns.
// Brief: briefs/BRIEF_NOO_Q4_VENDOR_V2_JOIN_2026-10-14.md §2b.
import fs from "node:fs"
import path from "node:path"
import { parseCsvTable } from "../lib/csv.ts"
import {
  MAIL_RECORD_JOIN_COLUMNS, WRITTEN_COLUMNS, PROTECTED_COLUMNS, IDENTITY_ECHO_COLUMNS,
  checkHeaders, buildV2Index, matchRecords, rowToUpdate, buildReport, formatReport,
} from "../lib/mailRecordsV2.ts"

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null }
const args = (k) => argv.flatMap((a, i) => (a === k && argv[i + 1] ? [argv[i + 1]] : []))
const campaign = arg("--campaign"), files = args("--file"), recordsJson = arg("--records-json"), commit = argv.includes("--commit")
if (!campaign || !files.length) {
  console.error("usage: --campaign <uuid> --file <csv> [--file <csv> …] [--commit] [--records-json <file>]")
  process.exit(1)
}
if (commit && recordsJson) { console.error("--records-json is for offline dry runs; drop it to --commit"); process.exit(1) }

// 1. Parse every file; hard-fail on a missing required header, warn on extras.
const parsedFiles = []
for (const f of files) {
  let table
  try { table = parseCsvTable(fs.readFileSync(f, "utf8")) } catch (e) { console.error(`${f}: ${e.message}`); process.exit(1) }
  const { missing, extra } = checkHeaders(table.header)
  if (missing.length) { console.error(`${f}: missing required headers: ${missing.join(", ")}`); process.exit(1) }
  if (extra.length) console.warn(`⚠ ${path.basename(f)}: ${extra.length} extra columns kept only in raw_v2 (${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", …" : ""})`)
  parsedFiles.push({ file: path.basename(f), rows: table.rows })
}
let index
try { index = buildV2Index(parsedFiles) } catch (e) { console.error(e.message); process.exit(1) }

// 3. Load every mail_records row for the campaign (or the offline fixture).
let sb = null
let records
if (recordsJson) {
  records = JSON.parse(fs.readFileSync(recordsJson, "utf8"))
  if (!Array.isArray(records)) { console.error("--records-json must be a JSON array of mail_records rows"); process.exit(1) }
} else {
  const { createClient } = await import("@supabase/supabase-js")
  if (!process.env.LRG_SUPABASE_URL || !process.env.LRG_SUPABASE_SERVICE_KEY) {
    console.error("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY not set — run with --env-file=.env.local, or pass --records-json for an offline dry run")
    process.exit(1)
  }
  sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  records = await loadRecords(MAIL_RECORD_JOIN_COLUMNS)
}

async function loadRecords(cols) {
  const out = []
  for (let from = 0; ; from += 1000) {
    // ORDER BY is load-bearing: PostgREST range paging without it returns overlapping pages (bit 2026-10-12).
    const { data, error } = await sb.from("mail_records").select(cols).eq("campaign_id", campaign).order("record_id").range(from, from + 999)
    if (error) { console.error(`mail_records read failed: ${error.message}`); process.exit(3) }
    out.push(...data); if (data.length < 1000) break
  }
  return out
}

// 4–6. Match, build the updates, report (always, before any write).
const match = matchRecords(records, index)
const now = new Date().toISOString()
const updates = match.matched.map((m) => rowToUpdate(m.v2.row, m.v2.file, now))
const report = buildReport(parsedFiles, index, records, match, updates)
console.log(formatReport(report))
if (!commit) { console.log("dry run — add --commit to write"); process.exit(0) }
if (!match.matched.length) { console.error("nothing matched — refusing to commit"); process.exit(2) }

// 7. Commit: upsert on id with only the v2 columns + id + campaign_id, plus
// record_id / arm echoed verbatim (NOT NULL columns — see IDENTITY_ECHO_COLUMNS).
// Belt and braces: every payload key must be a v2 column, id, campaign_id or an
// identity echo whose value equals the loaded row's.
const allowed = new Set([...WRITTEN_COLUMNS, "id", "campaign_id", ...IDENTITY_ECHO_COLUMNS])
const payload = match.matched.map((m, i) => ({ id: m.record.id, campaign_id: campaign, record_id: m.record.record_id, arm: m.record.arm, ...updates[i] }))
match.matched.forEach((m, i) => {
  const p = payload[i]
  for (const k of Object.keys(p)) {
    if (!allowed.has(k) || (PROTECTED_COLUMNS.includes(k) && !IDENTITY_ECHO_COLUMNS.includes(k))) { console.error(`refusing to write column ${k}`); process.exit(2) }
  }
  for (const k of IDENTITY_ECHO_COLUMNS) if (p[k] == null || p[k] !== m.record[k]) { console.error(`identity echo mismatch on ${k} for ${m.record.record_id}`); process.exit(2) }
})
// Sample captured BEFORE the write; sale_date must be byte-identical afterwards.
const sampleBefore = new Map(records.filter((r) => !r.is_seed).slice(0, 200).map((r) => [r.id, r.sale_date ?? null]))
const countBefore = records.length

for (let i = 0; i < payload.length; i += 500) {
  const { error } = await sb.from("mail_records").upsert(payload.slice(i, i + 500), { onConflict: "id" })
  if (error) { console.error(`upsert failed at ${i}: ${error.message}`); process.exit(3) }
  process.stdout.write(`\r  upserted ${Math.min(i + 500, payload.length)}/${payload.length}`)
}
console.log()

const after = await loadRecords("id, vendor_v2_at, sale_date")
const withV2 = after.filter((r) => r.vendor_v2_at != null).length
// Rows matched = distinct record ids written (one v2 row can serve several records).
const matchedIds = new Set(match.matched.map((m) => m.record.id)).size
const problems = []
if (after.length !== countBefore) problems.push(`row count changed: ${countBefore} → ${after.length}`)
if (withV2 !== matchedIds) problems.push(`rows with vendor_v2_at = ${withV2}, expected ${matchedIds}`)
const afterSale = new Map(after.map((r) => [r.id, r.sale_date ?? null]))
let drift = 0
for (const [id, before] of sampleBefore) if (afterSale.get(id) !== before) drift++
if (drift) problems.push(`sale_date changed on ${drift} of ${sampleBefore.size} sampled rows`)
if (problems.length) { console.error("RECONCILE FAIL:\n  " + problems.join("\n  ")); process.exit(2) }
console.log(`✓ reconciled · ${withV2} rows carry vendor_v2_at · ${after.length} rows unchanged · sale_date intact on ${sampleBefore.size}-row sample`)
