#!/usr/bin/env node
// Stamp when a direct-mail batch landed. Ryan learns the date from the seed piece
// (one per batch, mailed to his own address); the stamp goes on every row of the
// batch so segment timing can measure days-from-arrival. Dry-run by default.
//   node --env-file=.env.local scripts/stamp-arrived.mjs --campaign <uuid> --batch N --arrived YYYY-MM-DD [--drop YYYY-MM-DD] [--seed-only] [--commit]
import { createClient } from "@supabase/supabase-js"
const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }
const campaign = arg("--campaign"), batch = Number(arg("--batch")), arrived = arg("--arrived"), drop = arg("--drop")
const seedOnly = process.argv.includes("--seed-only"), commit = process.argv.includes("--commit")
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "")
if (!campaign || !Number.isInteger(batch) || batch < 1 || !isDate(arrived) || (drop && !isDate(drop))) {
  console.error("usage: --campaign <uuid> --batch N --arrived YYYY-MM-DD [--drop YYYY-MM-DD] [--seed-only] [--commit]"); process.exit(1)
}
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
let q = sb.from("mail_records").select("id, record_id, arm, is_seed, arrived_at, drop_date").eq("campaign_id", campaign).eq("batch", batch)
if (seedOnly) q = q.eq("is_seed", true)
const rows = []
for (let from = 0; ; from += 1000) { const { data, error } = await q.range(from, from + 999); if (error) throw error; rows.push(...data); if (data.length < 1000) break }
const already = rows.filter((r) => r.arrived_at).length
console.log(`batch ${batch}: ${rows.length} rows${seedOnly ? " (seeds only)" : ""} · ${already} already stamped · arms ${JSON.stringify(rows.reduce((a, r) => ((a[r.arm] = (a[r.arm] ?? 0) + 1), a), {}))}`)
if (!rows.length) process.exit(2)
if (!commit) { console.log(`dry run — would set arrived_at = ${arrived}${drop ? `, drop_date = ${drop}` : ""} on ${rows.length} rows; add --commit`); process.exit(0) }
const patch = { arrived_at: arrived, ...(drop ? { drop_date: drop } : {}) }
let upd = sb.from("mail_records").update(patch).eq("campaign_id", campaign).eq("batch", batch)
if (seedOnly) upd = upd.eq("is_seed", true)
const { data, error } = await upd.select("id")
if (error) throw error
if (data.length !== rows.length) { console.error(`RECONCILE FAIL: updated ${data.length}, expected ${rows.length}`); process.exit(2) }
console.log(`✓ stamped ${data.length} rows of batch ${batch}: arrived_at ${arrived}${drop ? `, drop_date ${drop}` : ""}`)
