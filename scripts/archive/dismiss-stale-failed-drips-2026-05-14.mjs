#!/usr/bin/env node
// One-off (2026-05-14): dismiss the stale `failed` drip_queue rows.
//
// Context: 13 rows failed with `sidecar send 404` on May 9-11 because the
// Mac-mini sidecar didn't have the `/send` route yet. That route exists now
// (verified live), so the cause is fixed — but the rows are 3-5 days stale
// and re-sending a "I had a missed call from this number" touch that late is
// wrong. The drip engine advances drip_touch_number + last_drip_sent_at
// *before* queueing, so the leads' cadences already moved past these touches;
// dismissing just clears the queue.
//
// Only touches rows whose error mentions the sidecar 404 — any other failure
// reason is left alone for review in the new Drips-tab Failed bucket.
//
// Run: node scripts/dismiss-stale-failed-drips-2026-05-14.mjs [--apply]
// Without --apply it's a dry run.

import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) {
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}

const APPLY = process.argv.includes("--apply")
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)

const { data: failed, error } = await sb
  .from("drip_queue")
  .select("id, lead_id, touch_number, campaign_type, channel, error, created_at")
  .eq("status", "failed")
  .order("created_at", { ascending: true })
if (error) { console.error("query failed:", error.message); process.exit(1) }

const stale = (failed ?? []).filter(r => (r.error || "").includes("sidecar send 404"))
console.log(`${failed?.length ?? 0} failed rows total · ${stale.length} match "sidecar send 404"`)
for (const r of stale) {
  console.log(`  ${r.created_at.slice(0, 16)}  touch#${r.touch_number}  ${r.channel}  ${r.campaign_type}  ${r.id}`)
}

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to dismiss these rows.")
  process.exit(0)
}

let dismissed = 0
for (const r of stale) {
  const { error: upErr } = await sb
    .from("drip_queue")
    .update({ status: "skipped", error: "dismissed_stale_sidecar_404_2026-05-14" })
    .eq("id", r.id)
    .eq("status", "failed")
  if (upErr) console.error(`  ✗ ${r.id}: ${upErr.message}`)
  else dismissed++
}
console.log(`\n✓ Dismissed ${dismissed}/${stale.length} stale failed rows.`)
