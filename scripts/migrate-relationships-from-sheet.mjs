#!/usr/bin/env node
// One-off: migrate the BoB Google Sheet → Supabase `relationships` +
// `relationship_touches`. Brief: briefs/RELATIONSHIPS_SUPABASE_MIGRATION.md §5 Phase 2.
//
// Usage:
//   node scripts/migrate-relationships-from-sheet.mjs --dry-run   # inspect, no writes
//   node scripts/migrate-relationships-from-sheet.mjs             # clear tables + migrate
//
// Idempotent: a real run clears both tables first, so it is safe to re-run.
// Delete this script after the Phase 7 cutover.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { google } from "googleapis"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

// --- env (.env.local) ---
for (const line of fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (process.env[m[1]] === undefined) process.env[m[1]] = v
}
const SUPABASE_URL = process.env.LRG_SUPABASE_URL
const SUPABASE_KEY = process.env.LRG_SUPABASE_SERVICE_KEY
const GOOGLE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("✗ LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing"); process.exit(1) }
if (!GOOGLE_KEY) { console.error("✗ GOOGLE_SERVICE_ACCOUNT_KEY missing"); process.exit(1) }

const DRY_RUN = process.argv.includes("--dry-run")
const SHEET_ID = "1sJyF3aLZxaGdA4l-i8G3Vy3yZliJjekdG6B9m3ydBIQ"
const ZERO_UUID = "00000000-0000-0000-0000-000000000000"

// --- parsing helpers — mirror app/api/crms/* + lib/crms.ts exactly ---
const digitsOnly = (p) => String(p ?? "").replace(/\D/g, "")
const phone10 = (p) => { const d = digitsOnly(p); return d.length >= 10 ? d.slice(-10) : d }
const toE164 = (p) => { const d = phone10(p); return d.length === 10 ? `+1${d}` : null }

function isBadName(name) {
  const n = String(name ?? "").trim()
  return !n || /^agent$/i.test(n) || /^agent\s/i.test(n)
}

const VALID_CATEGORIES = ["Agent", "Vendor", "Personal", "PM", "Investor", "PrivateMoney", "Seller"]
function normalizeCategory(raw) {
  const s = String(raw ?? "").trim()
  if (s === "Property Manager") return "PM"
  if (s === "Personal Contact") return "Personal"
  if (s === "Private Money" || s === "Private money") return "PrivateMoney"
  return VALID_CATEGORIES.includes(s) ? s : "Agent"
}

const VALID_TIERS = ["A", "B", "C", "D", "E"]
function normalizeTier(raw) {
  const t = String(raw ?? "C").trim().toUpperCase()
  return VALID_TIERS.includes(t) ? t : "C"
}

function parseDate(raw) {
  const s = String(raw ?? "").trim()
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

const ENRICHED_RE = /^\[enriched:\s*(\d{4}-\d{2}-\d{2})\]\s*/
function parseNote(note) {
  const raw = String(note ?? "")
  if (!raw.trim()) return { notes: null, enrichedAt: null }
  const m = raw.match(ENRICHED_RE)
  if (!m) return { notes: raw, enrichedAt: null }
  return { notes: raw.slice(m[0].length).trim() || null, enrichedAt: new Date(m[1] + "T00:00:00Z") }
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

  // --- read the BoB sheet ---
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_KEY),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  })
  const sheets = google.sheets({ version: "v4", auth })
  const { data } = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: ["Sheet1!A1:J2000", "Log!A1:K20000"],
  })
  const sheet1 = data.valueRanges?.[0]?.values ?? []
  const logTab = data.valueRanges?.[1]?.values ?? []
  console.log(`Sheet1: ${sheet1.length} rows (incl. header)   Log: ${logTab.length} rows (incl. header)\n`)

  // --- parse contacts (skip header row 0) ---
  const contacts = []
  const skipped = { empty: 0, badName: 0 }
  for (let i = 1; i < sheet1.length; i++) {
    const row = sheet1[i] ?? []
    if (row.every((c) => !String(c ?? "").trim())) { skipped.empty++; continue }
    const name = String(row[0] ?? "").trim()
    if (isBadName(name)) { skipped.badName++; continue }
    // Per the brief, migrate every BoB row. A missing/short phone comes over
    // as phone=null (the sheet-based UI hid these; the Supabase UI can show
    // them — they just can't enter the phone-based cadence queue).
    const e164 = toE164(row[1])
    const { notes, enrichedAt } = parseNote(row[8])
    contacts.push({
      sheetRow: i + 1,
      name,
      phone: e164,
      phone10: phone10(row[1]),
      email: String(row[2] ?? "").trim() || null,    // col C
      source: String(row[3] ?? "").trim() || null,   // col D
      category: normalizeCategory(row[4] ?? "Agent"),
      tier: normalizeTier(row[7]),
      notes,
      enriched_at: enrichedAt ? enrichedAt.toISOString() : null,
      last_contacted_at: parseDate(row[6])?.toISOString() ?? null,
      snooze_until: parseDate(row[9])?.toISOString() ?? null,
    })
  }

  // --- source_lead_id: best-effort phone match against leads.caller_phone ---
  const phones = [...new Set(contacts.map((c) => c.phone).filter(Boolean))]
  const phoneToLeadIds = new Map()
  let leadLookupOk = true
  for (const part of chunk(phones, 200)) {
    const { data: leads, error } = await supabase
      .from("leads").select("id, caller_phone").in("caller_phone", part)
    if (error) { console.warn(`⚠ lead phone lookup failed (${error.message}) — source_lead_id left null`); leadLookupOk = false; break }
    for (const l of leads ?? []) {
      if (!l.caller_phone) continue
      const arr = phoneToLeadIds.get(l.caller_phone) ?? []
      arr.push(l.id)
      phoneToLeadIds.set(l.caller_phone, arr)
    }
  }
  let matched = 0, ambiguous = 0
  for (const c of contacts) {
    const ids = phoneToLeadIds.get(c.phone) ?? []
    if (ids.length === 1) { c.source_lead_id = ids[0]; matched++ }
    else { c.source_lead_id = null; if (ids.length > 1) ambiguous++ }
  }

  // --- report ---
  const byCategory = {}, byTier = {}
  for (const c of contacts) {
    byCategory[c.category] = (byCategory[c.category] ?? 0) + 1
    byTier[c.tier] = (byTier[c.tier] ?? 0) + 1
  }
  const nullPhone = contacts.filter((c) => !c.phone).length
  const withEmail = contacts.filter((c) => c.email).length
  console.log("CONTACTS")
  console.log(`  to migrate : ${contacts.length}  (${nullPhone} no phone, ${withEmail} with email)`)
  console.log(`  skipped    : ${skipped.empty} empty, ${skipped.badName} bad-name (junk placeholder rows)`)
  console.log(`  by category: ${JSON.stringify(byCategory)}`)
  console.log(`  by tier    : ${JSON.stringify(byTier)}`)
  console.log(`  source_lead_id: ${matched} matched, ${ambiguous} ambiguous→null${leadLookupOk ? "" : " (lookup FAILED)"}`)
  console.log("  sample:")
  for (const c of contacts.slice(0, 5)) {
    console.log(`    ${c.name} | ${c.phone} | ${c.email ?? "(no email)"} | ${c.category}/${c.tier} | src=${c.source ?? "-"}`)
  }
  if (nullPhone) {
    console.log("  null-phone sample:")
    for (const c of contacts.filter((c) => !c.phone).slice(0, 6)) {
      console.log(`    ${c.name} | (no phone) | ${c.category}/${c.tier}`)
    }
  }

  // --- parse Log tab → touches (skip header if row 0 col A is not a date) ---
  const logStart = logTab.length && !parseDate(logTab[0]?.[0]) ? 1 : 0
  const logRows = logTab.slice(logStart)
  console.log(`\nLOG\n  rows (excl. header): ${logRows.length}`)

  if (DRY_RUN) {
    console.log("\n— DRY RUN — no writes. Re-run without --dry-run to apply.")
    return
  }

  // --- clear (idempotent) then insert relationships ---
  console.log("\nClearing relationship_touches + relationships …")
  let del = await supabase.from("relationship_touches").delete().neq("id", ZERO_UUID)
  if (del.error) throw new Error(`clear touches: ${del.error.message}`)
  del = await supabase.from("relationships").delete().neq("id", ZERO_UUID)
  if (del.error) throw new Error(`clear relationships: ${del.error.message}`)

  console.log(`Inserting ${contacts.length} relationships …`)
  const phone10ToRelId = new Map()
  let insertedCount = 0
  for (const part of chunk(contacts, 500)) {
    const payload = part.map((c) => ({
      name: c.name, phone: c.phone, email: c.email, source: c.source,
      category: c.category, tier: c.tier,
      notes: c.notes, enriched_at: c.enriched_at, last_contacted_at: c.last_contacted_at,
      snooze_until: c.snooze_until, source_lead_id: c.source_lead_id,
    }))
    const { data: inserted, error } = await supabase.from("relationships").insert(payload).select("id, phone")
    if (error) throw new Error(`insert relationships: ${error.message}`)
    insertedCount += inserted?.length ?? 0
    // Map keyed by 10-digit phone for touch linking; null-phone rows share
    // the "" key and are not reliably linkable (expected — they have no phone).
    for (const r of inserted ?? []) { if (r.phone) phone10ToRelId.set(phone10(r.phone), r.id) }
  }
  console.log(`  ✓ ${insertedCount} relationships inserted (${phone10ToRelId.size} phone-linkable)`)

  // --- insert touches ---
  const touches = []
  let orphanTouches = 0, badTs = 0
  for (const row of logRows) {
    const occurred = parseDate(row[0])
    if (!occurred) { badTs++; continue }
    const relId = phone10ToRelId.get(phone10(row[2])) ?? null
    if (!relId) orphanTouches++
    touches.push({
      relationship_id: relId,
      occurred_at: occurred.toISOString(),
      modality: row[4] || null,
      action: row[5] || null,
      message: row[8] || null,
      generated_message: row[9] || null,
      was_edited: row[10] === "true" ? true : row[10] === "false" ? false : null,
      tier_at_touch: row[6] || null,
      category_at_touch: row[7] || null,
    })
  }
  console.log(`Inserting ${touches.length} touches (${orphanTouches} orphan/null rel, ${badTs} bad-timestamp skipped) …`)
  for (const part of chunk(touches, 500)) {
    const { error } = await supabase.from("relationship_touches").insert(part)
    if (error) throw new Error(`insert touches: ${error.message}`)
  }

  // --- reconciliation ---
  const relCount = await supabase.from("relationships").select("*", { count: "exact", head: true })
  const touchCount = await supabase.from("relationship_touches").select("*", { count: "exact", head: true })
  console.log("\nRECONCILIATION")
  console.log(`  relationships in DB     : ${relCount.count}  (expected ${contacts.length})`)
  console.log(`  relationship_touches    : ${touchCount.count}  (expected ${touches.length})`)
  console.log(relCount.count === contacts.length && touchCount.count === touches.length
    ? "  ✓ counts match"
    : "  ✗ MISMATCH — investigate")
}

main().catch((e) => { console.error("✗", e.message); process.exit(1) })
