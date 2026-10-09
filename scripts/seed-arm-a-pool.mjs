#!/usr/bin/env node
// Seed campaign_zips.arm_a_hist from the list build's arm_a_pool_hist.csv
// (step9a: no-signal pool rows by county, zip, half-year tenure floor).
//   node --env-file=.env.local scripts/seed-arm-a-pool.mjs --campaign <uuid> --file <arm_a_pool_hist.csv> [--target 10300] [--commit]
// Every (zip, county) row of the campaign gets a hist (null when the zip has no
// pool rows, i.e. it was cut in Step 6). Never touches `exclude` or `arm_a_trim`.
import fs from "node:fs"
import { createClient } from "@supabase/supabase-js"
const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }
const campaign = arg("--campaign"), file = arg("--file"), target = arg("--target"), commit = process.argv.includes("--commit")
if (!campaign || !file) { console.error("usage: --campaign <uuid> --file <csv> [--target n] [--commit]"); process.exit(1) }
const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/)
const hdr = lines[0].split(",")
const hist = {} // "zip|county" → { half: rows }
let total = 0
for (const l of lines.slice(1)) {
  const r = Object.fromEntries(hdr.map((h, i) => [h, l.split(",")[i] ?? ""]))
  const k = `${r.zip}|${r.county}`; hist[k] ??= {}
  hist[k][r.half] = (hist[k][r.half] ?? 0) + Number(r.rows); total += Number(r.rows)
}
console.log(`${Object.keys(hist).length} zips with pool rows, ${total} pool rows${commit ? "" : " (dry run — add --commit)"}`)
if (!commit) process.exit(0)
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
const { data: rows, error } = await sb.from("campaign_zips").select("id, zip, county").eq("campaign_id", campaign)
if (error) throw error
const seen = new Set(); let withHist = 0
for (const z of rows) {
  const k = `${z.zip}|${z.county}`; seen.add(k)
  const h = hist[k] ?? null; if (h) withHist++
  const { error: e } = await sb.from("campaign_zips").update({ arm_a_hist: h, updated_at: new Date().toISOString() }).eq("id", z.id)
  if (e) throw e
}
const orphans = Object.keys(hist).filter((k) => !seen.has(k))
if (orphans.length) { console.error("RECONCILE FAIL: pool zips missing from campaign_zips:", orphans); process.exit(2) }
if (target) {
  const { error: pe } = await sb.from("campaign_list_params").upsert({ campaign_id: campaign, arm_a_target: Number(target), updated_at: new Date().toISOString() })
  if (pe) throw pe
}
// Verify the table sums back to the file.
const { data: back } = await sb.from("campaign_zips").select("arm_a_hist").eq("campaign_id", campaign).not("arm_a_hist", "is", null)
const dbTotal = back.reduce((a, r) => a + Object.values(r.arm_a_hist).reduce((x, y) => x + y, 0), 0)
console.log(`updated ${rows.length} zips (${withHist} with pool rows), table pool total ${dbTotal}${dbTotal === total ? " ✓" : " ✗ MISMATCH"}${target ? `, target ${target}` : ""}`)
if (dbTotal !== total) process.exit(2)
