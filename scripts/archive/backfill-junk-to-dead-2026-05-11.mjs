#!/usr/bin/env node
// One-shot — flip status=dead on every row already flagged is_junk=true.
//
// 2026-05-11: the lead card's "mark junk" toggle used to set is_junk=true
// without touching the lifecycle status, so junk leads kept showing up under
// the New filter. The toggle now also moves the row to status=dead (forward),
// but existing junk-flagged rows are still stuck wherever they were. This
// script does the one-time backfill so the filter is clean from today on.
//
// Usage:
//   cd PROJECTS/mission-control && node scripts/backfill-junk-to-dead-2026-05-11.mjs
//
// Safe to re-run — the WHERE clause excludes rows already at status=dead.

import { createClient } from "@supabase/supabase-js"
import { config } from "dotenv"
import { fileURLToPath } from "node:url"
import path from "node:path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(__dirname, "..", ".env.local") })

const url = process.env.LRG_SUPABASE_URL
const key = process.env.LRG_SUPABASE_SERVICE_KEY
if (!url || !key) {
  console.error("LRG_SUPABASE_URL and LRG_SUPABASE_SERVICE_KEY must be set")
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

// Dry-run first so we know what we're about to touch.
const { data: candidates, error: scanErr } = await sb
  .from("leads")
  .select("id, caller_phone, name, status, lead_type, created_at")
  .eq("is_junk", true)
  .neq("status", "dead")
  .order("created_at", { ascending: false })

if (scanErr) {
  console.error("[backfill-junk] scan failed:", scanErr.message)
  process.exit(1)
}

const rows = candidates || []
console.log(`[backfill-junk] ${rows.length} row(s) to promote to status=dead`)
for (const r of rows.slice(0, 50)) {
  console.log(
    `  ${r.created_at}  ${r.caller_phone || "(no phone)"}  ${r.name || "(no name)"}  was=${r.status}  type=${r.lead_type || "?"}  id=${r.id}`
  )
}
if (rows.length > 50) console.log(`  …and ${rows.length - 50} more`)

if (rows.length === 0) {
  console.log("[backfill-junk] nothing to do — exiting")
  process.exit(0)
}

const { error: updErr, count } = await sb
  .from("leads")
  .update({ status: "dead" }, { count: "exact" })
  .eq("is_junk", true)
  .neq("status", "dead")

if (updErr) {
  console.error("[backfill-junk] update failed:", updErr.message)
  process.exit(1)
}

console.log(`[backfill-junk] DONE — flipped ${count ?? rows.length} row(s) to status=dead`)
