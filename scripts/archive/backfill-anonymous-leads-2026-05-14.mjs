#!/usr/bin/env node
// One-off (2026-05-14): fix existing "Anonymous" lead rows.
//
// Background: Twilio sends a placeholder ("Anonymous" etc.) as caller_phone
// for blocked caller ID. Until today, intake stamped these like any lead —
// drip campaign and all — and groupLeads keyed cards on caller_phone, so
// every blocked caller collapsed into ONE shared card. The intake +
// groupLeads fixes handle new calls; this backfills the rows already in the
// table.
//
// Per anonymous row:
//   - SUBSTANTIVE (temp warm/hot, or has name/property_address/email) →
//     leave is_junk alone (it's a real lead; groupLeads now gives it its own
//     card automatically).
//   - NOT substantive → is_junk=true + clear drip_campaign_type /
//     drip_touch_number / last_drip_sent_at so the drip engine drops it.
//
// Dry-run by default; --apply to write.
//   node scripts/backfill-anonymous-leads-2026-05-14.mjs [--apply]

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

// Mirrors isAnonymousCaller() in lib/leads.ts — keep in sync.
const ANON = new Set(["anonymous", "restricted", "unavailable", "unknown", "private", "+266696687"])
const isAnon = (p) => !!p && ANON.has(String(p).trim().toLowerCase())

const { data: all, error } = await sb
  .from("leads")
  .select("id, caller_phone, lead_type, temperature, name, property_address, email, is_junk, drip_campaign_type, message, created_at")
  .limit(5000)
if (error) { console.error("query failed:", error.message); process.exit(1) }

const anon = (all ?? []).filter(l => isAnon(l.caller_phone))
console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`)
console.log(`${anon.length} anonymous lead row(s) found.\n`)

let junked = 0, kept = 0, failed = 0
for (const l of anon) {
  const substantive =
    l.temperature === "warm" || l.temperature === "hot" ||
    !!l.name || !!l.property_address || !!l.email
  if (substantive) {
    console.log(`  KEEP  ${l.id}  (substantive: temp=${l.temperature} name=${l.name ?? "-"} email=${l.email ?? "-"})`)
    kept++
    continue
  }
  const update = {
    is_junk: true,
    drip_campaign_type: null,
    drip_touch_number: null,
    last_drip_sent_at: null,
  }
  console.log(`  JUNK  ${l.id}  (${l.lead_type}, ${l.created_at?.slice(0,10)}, drip was ${l.drip_campaign_type ?? "none"})`)
  if (!APPLY) { junked++; continue }
  const { error: upErr } = await sb.from("leads").update(update).eq("id", l.id)
  if (upErr) { console.error(`    ✗ ${upErr.message}`); failed++ }
  else junked++
}

console.log(`\n${APPLY ? "Done" : "Dry-run"} — ${junked} junked, ${kept} kept (substantive), ${failed} failed.`)
if (!APPLY) console.log("Re-run with --apply to write.")
