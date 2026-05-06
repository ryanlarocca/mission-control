#!/usr/bin/env node
/**
 * Phase 7C — Part 10: per-campaign rollup of leads + activity counts.
 *
 *   node scripts/compute-campaign-metrics.mjs
 *
 * Groups leads by campaign_label (Phase 7C overlay) — falls back to
 * source for any unlabeled leftovers. Counts:
 *   * total_leads      — distinct leads in the campaign
 *   * total_calls      — lead_type IN ('call')
 *   * total_texts      — lead_type IN ('sms', 'drip_imessage')
 *   * total_emails     — lead_type IN ('email', 'drip_email')
 *   * total_voicemails — lead_type = 'voicemail'
 *   * hot/warm/nurture/dead/dnc/junk — counts by lifecycle status / flag
 *
 * Writes to campaign_metrics via UPSERT keyed on campaign_source.
 * Idempotent: safe to run on a cron later. For now, run on demand and
 * the Leads tab fetches the resulting rows for its analytics strip.
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[k] === undefined) process.env[k] = v
  }
}

const PAT = process.env.SUPABASE_PAT
const REF = process.env.SUPABASE_PROJECT_REF
if (!PAT || !REF) {
  console.error("SUPABASE_PAT and SUPABASE_PROJECT_REF must be set")
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

// Single SQL statement that pivots leads grouped by campaign_label
// (with a COALESCE fallback to source) into the metric shape we need,
// then upserts into campaign_metrics with all the relevant fields.
//
// We compute lead-level counts on a per-CONTACT basis (a lead in this
// codebase = one event row, so multiple events on the same person inflate
// the raw count — DISTINCT on caller_phone || email || id collapses them).
const SQL = `
WITH base AS (
  SELECT
    COALESCE(campaign_label, source, 'Unknown') AS campaign_source,
    id,
    caller_phone,
    email,
    lead_type,
    status,
    is_dnc,
    is_junk,
    -- One canonical contact key per row so DISTINCT collapses event rows.
    COALESCE(caller_phone, email, id::text) AS contact_key
  FROM leads
),
contact_status AS (
  -- Best status per contact: prefer non-default lifecycle stages over "new".
  -- We pick the status of the most recent event for each contact.
  SELECT DISTINCT ON (campaign_source, contact_key)
    campaign_source, contact_key, status, is_dnc, is_junk
  FROM base b1
  ORDER BY campaign_source, contact_key, (
    SELECT created_at FROM leads WHERE id = b1.id
  ) DESC
),
agg AS (
  SELECT
    campaign_source,
    COUNT(DISTINCT contact_key)::int AS total_leads,
    COUNT(*) FILTER (WHERE lead_type = 'call')::int AS total_calls,
    COUNT(*) FILTER (WHERE lead_type IN ('sms', 'drip_imessage'))::int AS total_texts,
    COUNT(*) FILTER (WHERE lead_type IN ('email', 'drip_email'))::int AS total_emails,
    COUNT(*) FILTER (WHERE lead_type = 'voicemail')::int AS total_voicemails
  FROM base
  GROUP BY campaign_source
),
status_agg AS (
  SELECT
    campaign_source,
    COUNT(*) FILTER (WHERE status = 'hot')::int AS hot_count,
    COUNT(*) FILTER (WHERE status = 'warm')::int AS warm_count,
    COUNT(*) FILTER (WHERE status = 'nurture')::int AS nurture_count,
    COUNT(*) FILTER (WHERE status = 'dead')::int AS dead_count,
    COUNT(*) FILTER (WHERE is_dnc = true)::int AS dnc_count,
    COUNT(*) FILTER (WHERE is_junk = true)::int AS junk_count
  FROM contact_status
  GROUP BY campaign_source
)
INSERT INTO campaign_metrics (
  campaign_source, total_leads, total_calls, total_texts, total_emails,
  total_voicemails, hot_count, warm_count, nurture_count, dead_count,
  dnc_count, junk_count, last_computed_at
)
SELECT
  agg.campaign_source,
  agg.total_leads,
  agg.total_calls,
  agg.total_texts,
  agg.total_emails,
  agg.total_voicemails,
  COALESCE(status_agg.hot_count, 0),
  COALESCE(status_agg.warm_count, 0),
  COALESCE(status_agg.nurture_count, 0),
  COALESCE(status_agg.dead_count, 0),
  COALESCE(status_agg.dnc_count, 0),
  COALESCE(status_agg.junk_count, 0),
  now()
FROM agg
LEFT JOIN status_agg USING (campaign_source)
ON CONFLICT (campaign_source) DO UPDATE SET
  total_leads = EXCLUDED.total_leads,
  total_calls = EXCLUDED.total_calls,
  total_texts = EXCLUDED.total_texts,
  total_emails = EXCLUDED.total_emails,
  total_voicemails = EXCLUDED.total_voicemails,
  hot_count = EXCLUDED.hot_count,
  warm_count = EXCLUDED.warm_count,
  nurture_count = EXCLUDED.nurture_count,
  dead_count = EXCLUDED.dead_count,
  dnc_count = EXCLUDED.dnc_count,
  junk_count = EXCLUDED.junk_count,
  last_computed_at = now()
RETURNING *;
`

async function main() {
  console.log(`[metrics] computing per-campaign rollups…`)
  const rows = await runQuery(SQL)
  if (Array.isArray(rows)) {
    console.log(`[metrics] upserted ${rows.length} campaign row(s):`)
    for (const r of rows.sort((a, b) => (b.total_leads || 0) - (a.total_leads || 0))) {
      console.log(
        `  ${(r.campaign_source || "?").padEnd(15)} ` +
        `leads=${r.total_leads} calls=${r.total_calls} texts=${r.total_texts} ` +
        `emails=${r.total_emails} vm=${r.total_voicemails} | ` +
        `hot=${r.hot_count} warm=${r.warm_count} nurture=${r.nurture_count} ` +
        `dead=${r.dead_count} dnc=${r.dnc_count} junk=${r.junk_count}`
      )
    }
  } else {
    console.log(`[metrics] non-array response:`, rows)
  }
}

main().catch((e) => {
  console.error("[metrics] fatal:", e.message || e)
  process.exit(1)
})
