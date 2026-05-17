#!/usr/bin/env node
// One-shot: apply the 2026-05-16 triage decisions.
//   DNC (4):     Anonymous, Muriel Sivyer-Lee, Victor Rodriguez, +16506786431
//   Nurture (5): Stuart, Yipei, Terry Chandler, Kiko Ohata, Dennis Connally
//
// DNC mirrors POST /api/leads/[id]/dnc:
//   - for every lead row in the cluster: is_dnc=true, status=dead
//   - one dnc_list row per cluster (uses property_address + name from rep row)
//
// Nurture sets status='nurture' on every row in the cluster. (No is_dnc change.)
//
// Re-runnable: dnc_list lacks a unique constraint so a second pass adds a
// duplicate row but is otherwise harmless; is_dnc + status writes are idempotent.

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

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)

// (cluster_key, reason) for DNC; cluster_key for nurture.
const DNC = [
  { key: "Anonymous",                    keyCol: "name",         reason: "hostile" },
  { key: "murielsivyerlee@gmail.com",    keyCol: "email",        reason: "requested" },
  { key: "+14086557815",                 keyCol: "caller_phone", reason: "requested" }, // Victor Rodriguez
  { key: "+16506786431",                 keyCol: "caller_phone", reason: "requested" }, // 92yo estate-to-nephew
]
const NURTURE = [
  { key: "+14082579008",                 keyCol: "caller_phone" }, // Stuart
  { key: "+14084103762",                 keyCol: "caller_phone" }, // Yipei
  { key: "terry_chandler2000@yahoo.com", keyCol: "email"        }, // Terry Chandler
  { key: "+16507667727",                 keyCol: "caller_phone" }, // Kiko Ohata
  { key: "dennisconnally10@gmail.com",   keyCol: "email"        }, // Dennis Connally
]

async function fetchCluster({ key, keyCol }) {
  const { data, error } = await sb.from("leads")
    .select("id, name, property_address, caller_phone, email, status, is_dnc, lead_type, created_at")
    .eq(keyCol, key)
    .order("created_at", { ascending: true })
  if (error) throw new Error(`fetch ${keyCol}=${key}: ${error.message}`)
  return data || []
}

const hr = "─".repeat(78)
console.log(hr)
console.log("APPLY TRIAGE 2026-05-16")
console.log(hr)

// ── DNC ──
let dncRows = 0, dncListRows = 0, dncClusters = 0
for (const tgt of DNC) {
  const cluster = await fetchCluster(tgt)
  if (!cluster.length) {
    console.log(`\n⚠ DNC cluster ${tgt.keyCol}=${tgt.key} returned 0 rows — skipped`)
    continue
  }
  const rep = cluster.find((r) => r.property_address || r.name) || cluster[0]
  const ids = cluster.map((r) => r.id)
  const { error: updErr } = await sb.from("leads")
    .update({ is_dnc: true, status: "dead" })
    .in("id", ids)
  if (updErr) { console.log(`\n❌ DNC update failed ${tgt.key}: ${updErr.message}`); continue }
  // Insert one dnc_list row per cluster.
  const { error: dncErr } = await sb.from("dnc_list").insert({
    site_address: rep.property_address || null,
    owner_name: rep.name || null,
    source_lead_id: rep.id,
    reason: tgt.reason,
    added_by: "ryan",
  })
  dncClusters++
  dncRows += ids.length
  if (!dncErr) dncListRows++
  const dncListNote = dncErr ? `dnc_list FAILED: ${dncErr.message}` : "dnc_list +1"
  console.log(`\n✓ DNC  ${tgt.key.padEnd(36)} ${ids.length} row(s) → is_dnc=true status=dead  [${tgt.reason}]  ${dncListNote}`)
}

// ── Nurture ──
let nurtRows = 0, nurtClusters = 0
for (const tgt of NURTURE) {
  const cluster = await fetchCluster(tgt)
  if (!cluster.length) {
    console.log(`\n⚠ Nurture cluster ${tgt.keyCol}=${tgt.key} returned 0 rows — skipped`)
    continue
  }
  const ids = cluster.map((r) => r.id)
  const { error } = await sb.from("leads")
    .update({ status: "nurture" })
    .in("id", ids)
  if (error) { console.log(`\n❌ Nurture update failed ${tgt.key}: ${error.message}`); continue }
  nurtClusters++
  nurtRows += ids.length
  console.log(`\n✓ Nurture  ${tgt.key.padEnd(36)} ${ids.length} row(s) → status=nurture`)
}

console.log("\n" + hr)
console.log(`SUMMARY`)
console.log(`  DNC:     ${dncClusters} cluster(s), ${dncRows} lead rows, ${dncListRows} dnc_list row(s)`)
console.log(`  Nurture: ${nurtClusters} cluster(s), ${nurtRows} lead rows`)
console.log(hr)
