#!/usr/bin/env node
// Seed campaign_zips from a list-build zip_table.csv (Step 5 output).
//   node --env-file=.env.local scripts/seed-campaign-zips.mjs --campaign <uuid> --file <zip_table.csv> [--commit]
// Upserts on (campaign_id, zip); never touches `exclude` on rows that already exist.
import fs from "node:fs"
import { createClient } from "@supabase/supabase-js"
const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }
const campaign = arg("--campaign"), file = arg("--file"), commit = process.argv.includes("--commit")
if (!campaign || !file) { console.error("usage: --campaign <uuid> --file <csv> [--commit]"); process.exit(1) }
const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/)
const hdr = lines[0].split(",")
const rows = lines.slice(1).map((l) => { const c = l.split(","); return Object.fromEntries(hdr.map((h, i) => [h, c[i] ?? ""])) })
const payload = rows.map((r) => ({
  campaign_id: campaign, zip: r.zip, city: r.city, county: r.county, rows: Number(r.rows),
  median_year_built: r.median_year_built ? Number(r.median_year_built) : null,
  median_tenure_years: r.median_tenure_years ? Number(r.median_tenure_years) : null,
  cumulative_in_county: r.cumulative_in_county ? Number(r.cumulative_in_county) : null,
}))
console.log(`${payload.length} zips, ${payload.reduce((a, r) => a + r.rows, 0)} rows${commit ? "" : " (dry run — add --commit)"}`)
if (!commit) process.exit(0)
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
const { data: existing } = await sb.from("campaign_zips").select("zip").eq("campaign_id", campaign)
const have = new Set((existing ?? []).map((r) => r.zip))
const fresh = payload.filter((r) => !have.has(r.zip))
if (fresh.length) { const { error } = await sb.from("campaign_zips").insert(fresh); if (error) throw error }
const { count } = await sb.from("campaign_zips").select("id", { count: "exact", head: true }).eq("campaign_id", campaign)
console.log(`inserted ${fresh.length}, skipped ${payload.length - fresh.length} existing, table now ${count} for this campaign`)
if (count !== payload.length) { console.error("RECONCILE FAIL"); process.exit(2) }
