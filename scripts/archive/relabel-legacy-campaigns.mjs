#!/usr/bin/env node
/**
 * Phase 7C — backfill `campaign_label` on existing leads.
 *
 *   node scripts/relabel-legacy-campaigns.mjs [--dry-run]
 *
 * Convention going forward:
 *   - source = 'MFM-A'                → campaign_label = 'MFM-A'
 *   - source = 'MFM-B'                → campaign_label = 'MFM-B'
 *   - source_type = 'google_ads'      → campaign_label = 'Google Ads'
 *   - any other direct_mail source    → campaign_label = 'DM-Legacy'
 *   - source_type = 'website' (form)  → campaign_label = 'Website'
 *
 * `source` stays untouched so historical reporting against the raw
 * twilio-number → campaign mapping still works. `campaign_label` is the
 * canonical display label going forward and is what the Leads tab reads.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_PATH = path.join(__dirname, "..", ".env.local")

if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq < 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (process.env[k] === undefined) process.env[k] = v
  }
}

const DRY = process.argv.includes("--dry-run")

const PAT = process.env.SUPABASE_PAT
const REF = process.env.SUPABASE_PROJECT_REF
if (!PAT || !REF) {
  console.error("SUPABASE_PAT and SUPABASE_PROJECT_REF must be in .env.local")
  process.exit(1)
}

async function runQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Supabase API ${res.status}: ${text.slice(0, 400)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const RULES = [
  {
    name: "MFM-A",
    where: `source = 'MFM-A'`,
    label: "MFM-A",
  },
  {
    name: "MFM-B",
    where: `source = 'MFM-B'`,
    label: "MFM-B",
  },
  {
    name: "Google Ads",
    where: `source_type = 'google_ads' OR source = 'Google Ads'`,
    label: "Google Ads",
  },
  {
    name: "Website (form)",
    where: `source_type = 'website'`,
    label: "Website",
  },
  // Catch-all for any pre-MFM direct mail (SVR-A, SVR-B, SVG-A, SVJ-B, etc.)
  {
    name: "DM-Legacy",
    where: `source_type = 'direct_mail' AND source NOT IN ('MFM-A','MFM-B') AND source IS NOT NULL`,
    label: "DM-Legacy",
  },
]

async function main() {
  console.log(`[relabel] mode=${DRY ? "DRY-RUN" : "WRITE"}`)
  for (const rule of RULES) {
    const countSql = `SELECT COUNT(*)::int AS n FROM leads WHERE (${rule.where}) AND (campaign_label IS DISTINCT FROM '${rule.label.replace(/'/g, "''")}')`
    const counts = await runQuery(countSql)
    const n = Array.isArray(counts) ? counts[0]?.n ?? 0 : 0
    console.log(`[relabel] ${rule.name.padEnd(15)} → "${rule.label}" — ${n} row(s) to update`)

    if (DRY || n === 0) continue

    const updSql = `UPDATE leads SET campaign_label = '${rule.label.replace(/'/g, "''")}' WHERE (${rule.where}) AND (campaign_label IS DISTINCT FROM '${rule.label.replace(/'/g, "''")}')`
    await runQuery(updSql)
  }

  // Final distribution snapshot.
  const dist = await runQuery(`SELECT campaign_label, COUNT(*)::int AS n FROM leads GROUP BY campaign_label ORDER BY n DESC`)
  console.log(`\n[relabel] final distribution:`)
  for (const row of dist) {
    console.log(`  ${(row.campaign_label || "(null)").padEnd(15)} ${row.n}`)
  }
}

main().catch((e) => {
  console.error("[relabel] fatal:", e.message || e)
  process.exit(1)
})
