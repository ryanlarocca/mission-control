#!/usr/bin/env node
// One-time backfill: assign campaign_id to every existing lead by
// re-running the same resolver the ingest routes use.
//
// Usage:
//   node scripts/backfill-campaign-ids-2026-05-17.mjs --dry-run
//   node scripts/backfill-campaign-ids-2026-05-17.mjs            # apply
//
// Resolver logic is duplicated here (not imported) so the script runs as
// bare node without Next.js' build. Keep in sync with lib/campaigns.ts.

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

const DRY = process.argv.includes("--dry-run")
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)

// Cache campaigns once at script start — they don't change during backfill.
const { data: campaigns, error: cErr } = await sb
  .from("campaigns")
  .select("id, channel, variant, drop_date, created_at, parent_campaign_id")
if (cErr) { console.error("Campaigns query failed:", cErr); process.exit(1) }

function resolve(source, sourceType, createdAt) {
  if (!source && !sourceType) return null
  const s = (source ?? "").toUpperCase()
  let variant = null, channel = null
  if (s === "MFM-A" || s === "SVG-A") { variant = "pink-envelope"; channel = "direct_mail" }
  else if (s === "MFM-B" || s === "SVJ-B") { variant = "white-envelope"; channel = "direct_mail" }
  else if (s === "GOOGLE" || s === "GOOGLE ADS" || sourceType === "google_ads") { channel = "google_ads" }
  if (!channel) return null

  const created = createdAt ? new Date(createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
  const candidates = campaigns
    .filter(c => c.channel === channel)
    .filter(c => !variant || c.variant === variant)
    .filter(c => !c.drop_date || c.drop_date <= created)
    .sort((a, b) => {
      const ad = a.drop_date || ""
      const bd = b.drop_date || ""
      if (ad !== bd) return bd.localeCompare(ad)
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  if (candidates.length === 0) return null
  const child = candidates.find(c => c.parent_campaign_id) ?? candidates[0]
  return child.id
}

const { data: leads, error } = await sb
  .from("leads")
  .select("id, source, source_type, created_at, campaign_id")
  .is("campaign_id", null)
if (error) { console.error(error); process.exit(1) }

console.log(`Found ${leads.length} leads with null campaign_id`)
const tally = new Map()
let assigned = 0
const updates = []
for (const lead of leads) {
  const cid = resolve(lead.source, lead.source_type, lead.created_at)
  if (!cid) {
    const key = `(no match) ${lead.source ?? "—"} / ${lead.source_type ?? "—"}`
    tally.set(key, (tally.get(key) || 0) + 1)
    continue
  }
  updates.push({ id: lead.id, campaign_id: cid })
  const c = campaigns.find(x => x.id === cid)
  const key = `${c.channel}${c.variant ? "/" + c.variant : ""} (drop=${c.drop_date || "—"})`
  tally.set(key, (tally.get(key) || 0) + 1)
  assigned++
}

console.log("\nAssignment summary:")
for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${k}`)
}
console.log(`\nWould assign: ${assigned}/${leads.length}`)

if (DRY || updates.length === 0) {
  console.log(DRY ? "\nDry run — no writes." : "\nNothing to do.")
  process.exit(0)
}

// Batch updates — one row at a time but use Promise.all in chunks of 25 to keep it snappy.
const CHUNK = 25
let done = 0
for (let i = 0; i < updates.length; i += CHUNK) {
  const slice = updates.slice(i, i + CHUNK)
  await Promise.all(slice.map(u => sb.from("leads").update({ campaign_id: u.campaign_id }).eq("id", u.id)))
  done += slice.length
  process.stdout.write(`\rWriting ${done}/${updates.length}…`)
}
console.log(`\n✓ Done. ${done} rows updated.`)
