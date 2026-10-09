#!/usr/bin/env node
// Dump the Arm A rule Ryan set in the picker (/campaigns/zips, Arm A mode) for
// the list build's Step 9: tenure floor + the zips trimmed from Arm A.
//   node --env-file=.env.local scripts/export-arm-a-cutoffs.mjs --campaign <uuid> --out <arm_a_cutoffs.json>
import fs from "node:fs"
import { createClient } from "@supabase/supabase-js"
const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }
const campaign = arg("--campaign"), out = arg("--out")
if (!campaign || !out) { console.error("usage: --campaign <uuid> --out <json>"); process.exit(1) }
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
const [{ data: lp, error: e1 }, { data: zips, error: e2 }] = await Promise.all([
  sb.from("campaign_list_params").select("*").eq("campaign_id", campaign).maybeSingle(),
  sb.from("campaign_zips").select("zip, county, city, exclude, arm_a_trim, arm_a_hist").eq("campaign_id", campaign),
])
if (e1 || e2) throw e1 ?? e2
if (!lp || lp.arm_a_tenure_floor == null) { console.error("No Arm A tenure floor saved for this campaign — set it in the picker first"); process.exit(2) }
const floor = Number(lp.arm_a_tenure_floor)
const at = (h) => (h ? Object.entries(h).reduce((a, [k, v]) => a + (Number(k) >= floor ? v : 0), 0) : 0)
const trimmed = zips.filter((z) => z.arm_a_trim && !z.exclude).map((z) => ({ zip: z.zip, county: z.county, city: z.city, rows_at_floor: at(z.arm_a_hist) }))
const armA = zips.filter((z) => !z.exclude && !z.arm_a_trim).reduce((a, z) => a + at(z.arm_a_hist), 0)
const payload = { campaign_id: campaign, exported_at: new Date().toISOString(), arm_a_tenure_floor: floor, arm_a_target: lp.arm_a_target, arm_b_count: lp.arm_b_count, expected_arm_a: armA, trimmed_zips: trimmed }
fs.writeFileSync(out, JSON.stringify(payload, null, 1))
console.log(`floor ≥ ${floor} yrs · ${trimmed.length} zips trimmed from Arm A · expected Arm A ${armA} (target ${lp.arm_a_target}) → ${out}`)
