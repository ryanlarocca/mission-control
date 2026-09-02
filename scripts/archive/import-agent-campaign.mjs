#!/usr/bin/env node
/**
 * Agent email-drip campaign — contact importer (Phase 2 of
 * briefs/EMAIL_DRIP_CAMPAIGN_2026-07-17.md).
 *
 *   node scripts/import-agent-campaign.mjs <raw.json> [--commit]
 *
 * <raw.json> is the spreadsheet converted to a JSON array of row objects
 * (keys = the dialer-CRM export headers). Default is a DRY RUN that prints
 * the full import report and writes nothing. --commit performs the writes:
 *   - campaign_contacts rows (merged, normalized, scrubbed)
 *   - suppression rows for opt-outs found in the CRM data itself
 *     (prior Brevo unsubscribes → channel 'email'; call-note opt-outs →
 *     channel 'all', except explicit "call list" asks → channel 'call')
 *
 * Hygiene pipeline (in order):
 *   1. normalize email (lowercase; salvage "a or b" double-entries) + phone
 *   2. drop junk placeholder rows (Non Member etc., noemail@email.com)
 *   3. merge person-level duplicates (same Full Name → primary + alt emails)
 *   4. harvest opt-outs (CRM email status + notes scan) → suppression
 *   5. scrub against master suppression (channel email)
 *   6. MX-validate email domains (no MX and no A record → bad_email)
 *   7. cross-reference leads (active conversation → flag, NOT excluded)
 *      and relationships (flag only — BoB never blocks the drip)
 *
 * Idempotent: re-running --commit upserts by email (unique index) and
 * re-checks suppression source_refs, so a second run is a no-op.
 */

import fs from "node:fs"
import path from "node:path"
import dns from "node:dns/promises"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

// ---------- env ----------
for (const line of fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf-8").split(/\r?\n/)) {
  const eq = line.indexOf("=")
  if (eq < 0 || line.trim().startsWith("#")) continue
  const key = line.slice(0, eq).trim()
  let val = line.slice(eq + 1).trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
  if (process.env[key] === undefined) process.env[key] = val
}
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
})

// ---------- args ----------
const args = process.argv.slice(2)
const commit = args.includes("--commit")
const jsonPath = args.find((a) => !a.startsWith("--"))
if (!jsonPath) {
  console.error("usage: node scripts/import-agent-campaign.mjs <raw.json> [--commit]")
  process.exit(1)
}
const rawRows = JSON.parse(fs.readFileSync(jsonPath, "utf-8"))

// ---------- helpers ----------
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/
const norm = (v) => String(v ?? "").trim()
const normEmail = (v) => {
  let s = norm(v).toLowerCase()
  if (!s) return null
  if (!EMAIL_RE.test(s)) {
    // salvage "a@x.com or b@y.com" double-entries: take the first valid token
    const tok = s.split(/[\s,;]+/).find((t) => EMAIL_RE.test(t))
    s = tok ?? s
  }
  return EMAIL_RE.test(s) ? s : null
}
const normPhone = (v) => {
  const d = norm(v).replace(/\D/g, "")
  return d.length >= 10 ? d.slice(-10) : null
}
const JUNK_NAME_RE = /^(non ?member( sales)?|general nonmember)$/i
const JUNK_EMAILS = new Set(["noemail@email.com"])
const OPTOUT_RE = /take me off|do not (call|text|contact)|stop (calling|texting)|remove me from|\bdnc\b|unsubscrib/i
const CALL_ONLY_RE = /call list/i
const BAD_PHONE_RESULTS = new Set(["Bad Number", "Disconnected"])

// ---------- 1+2: normalize & drop junk ----------
const contacts = []
let junkDropped = 0
for (const r of rawRows) {
  const name = norm(r["Full Name"])
  const emailRaw = norm(r["Email 1"])
  const email = normEmail(emailRaw)
  const phone = normPhone(r["Primary Phone"] || r["Phone 1"] || r["Phone 7"])
  if (JUNK_NAME_RE.test(name) || (emailRaw && JUNK_EMAILS.has(emailRaw.toLowerCase()))) {
    junkDropped++
    continue
  }
  contacts.push({
    name,
    first_name: norm(r["First Name"]) || null,
    last_name: norm(r["Last Name"]) || null,
    email,
    email_was_malformed: Boolean(emailRaw) && !EMAIL_RE.test(emailRaw.toLowerCase()),
    phone,
    property_address: norm(r["Property Address"]) || null,
    crm_last_call_result: norm(r["Last Call Result"]) || null,
    crm_email_status: norm(r["Last Email Status"]) || null,
    crm_notes: norm(r["Notes"]) || null,
    raw: r,
  })
}

// ---------- 3: person-level merge by identical name ----------
const byName = new Map()
const merged = []
const mergeLog = []
for (const c of contacts) {
  const key = c.name.toLowerCase()
  if (!key) { merged.push(c); continue }
  const prev = byName.get(key)
  if (!prev) {
    byName.set(key, c)
    merged.push(c)
    continue
  }
  // merge c into prev: keep first non-null primary, stash the rest
  prev.alt_emails = prev.alt_emails ?? []
  prev.alt_phones = prev.alt_phones ?? []
  if (c.email && c.email !== prev.email) {
    if (!prev.email) prev.email = c.email
    else if (!prev.alt_emails.includes(c.email)) prev.alt_emails.push(c.email)
  }
  if (c.phone && c.phone !== prev.phone) {
    if (!prev.phone) prev.phone = c.phone
    else if (!prev.alt_phones.includes(c.phone)) prev.alt_phones.push(c.phone)
  }
  for (const f of ["property_address", "crm_last_call_result", "crm_email_status"]) {
    if (!prev[f] && c[f]) prev[f] = c[f]
  }
  if (c.crm_notes) prev.crm_notes = [prev.crm_notes, c.crm_notes].filter(Boolean).join("\n\n")
  prev.import_flags = prev.import_flags ?? []
  if (!prev.import_flags.includes("merged")) prev.import_flags.push("merged")
  mergeLog.push(`${c.name}: ${c.email ?? c.phone ?? "(no id)"} → merged into ${prev.email ?? prev.phone}`)
}

// ---------- 4: harvest opt-outs from the CRM data itself ----------
const suppressionInserts = [] // rows for the suppression table
const optOutLog = []
for (const c of merged) {
  const status = (c.crm_email_status ?? "").toLowerCase()
  if (status === "unsubscribed") {
    c.import_status = "unsubscribed"
    suppressionInserts.push({
      email: c.email, phone: c.phone, name: c.name,
      reason: "unsubscribed from prior email campaign (Brevo, per dialer-CRM export)",
      source: "prior_email_unsubscribe", source_ref: c.email ?? c.phone,
      channel: "email", audience: "agent",
    })
    optOutLog.push(`unsub(email): ${c.name} <${c.email}>`)
    continue
  }
  const noteHit = c.crm_notes && OPTOUT_RE.exec(c.crm_notes)
  if (noteHit) {
    const callOnly = CALL_ONLY_RE.test(c.crm_notes)
    const channel = callOnly ? "call" : "all"
    if (!callOnly) c.import_status = "suppressed"
    suppressionInserts.push({
      email: c.email, phone: c.phone, name: c.name,
      reason: `opt-out in dialer call notes ("${noteHit[0]}"${callOnly ? ", call list only" : ""})`,
      source: "call_note_optout", source_ref: c.email ?? c.phone,
      channel, audience: "agent",
    })
    optOutLog.push(`note(${channel}): ${c.name} <${c.email ?? c.phone}> — "${noteHit[0]}"`)
  }
  if (status === "failed") c.import_status = "bad_email"
}

// ---------- 5: scrub against master suppression ----------
const { data: suppRows, error: suppErr } = await sb
  .from("suppression")
  .select("email, phone")
  .in("channel", ["email", "all"])
if (suppErr) { console.error("suppression fetch failed:", suppErr.message); process.exit(1) }
const suppEmails = new Set(suppRows.map((r) => r.email).filter(Boolean))
const suppPhones = new Set(suppRows.map((r) => r.phone).filter(Boolean))
let masterSuppressed = 0
for (const c of merged) {
  if (c.import_status) continue
  if ((c.email && suppEmails.has(c.email)) || (c.phone && suppPhones.has(c.phone))) {
    c.import_status = "suppressed"
    c.import_flags = [...(c.import_flags ?? []), "master_dnc_match"]
    masterSuppressed++
  }
}

// ---------- 6: MX validation ----------
const domains = new Map() // domain → ok boolean
for (const c of merged) {
  if (c.email) domains.set(c.email.split("@")[1], null)
}
const domainList = [...domains.keys()]
const CONCURRENCY = 20
let di = 0
async function mxWorker() {
  while (di < domainList.length) {
    const d = domainList[di++]
    let ok = false
    try {
      const mx = await dns.resolveMx(d)
      ok = mx.length > 0
    } catch {
      try { ok = (await dns.resolve4(d)).length > 0 } catch { ok = false }
    }
    domains.set(d, ok)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, mxWorker))
const deadDomains = domainList.filter((d) => domains.get(d) === false)
let mxBad = 0
for (const c of merged) {
  if (c.import_status || !c.email) continue
  if (domains.get(c.email.split("@")[1]) === false) {
    c.import_status = "bad_email"
    c.import_flags = [...(c.import_flags ?? []), "mx_dead"]
    mxBad++
  }
}

// ---------- 7: cross-reference leads + relationships (flags only) ----------
const { data: leadRows, error: leadErr } = await sb
  .from("leads")
  .select("email, caller_phone, status")
  .in("status", ["new", "contacted", "active"])
if (leadErr) { console.error("leads fetch failed:", leadErr.message); process.exit(1) }
const leadEmails = new Set(leadRows.map((r) => (r.email ?? "").toLowerCase()).filter(Boolean))
const leadPhones = new Set(leadRows.map((r) => normPhone(r.caller_phone)).filter(Boolean))

const { data: relRows, error: relErr } = await sb.from("relationships").select("email, phone")
if (relErr) { console.error("relationships fetch failed:", relErr.message); process.exit(1) }
const relEmails = new Set(relRows.map((r) => (r.email ?? "").toLowerCase()).filter(Boolean))
const relPhones = new Set(relRows.map((r) => normPhone(r.phone)).filter(Boolean))

const activeLeadFlags = []
let relOverlap = 0
for (const c of merged) {
  if ((c.email && leadEmails.has(c.email)) || (c.phone && leadPhones.has(c.phone))) {
    c.import_flags = [...(c.import_flags ?? []), "active_lead"]
    activeLeadFlags.push(`${c.name} <${c.email ?? c.phone}>`)
  }
  if ((c.email && relEmails.has(c.email)) || (c.phone && relPhones.has(c.phone))) {
    c.import_flags = [...(c.import_flags ?? []), "relationships_overlap"]
    relOverlap++
  }
}

// ---------- finalize statuses ----------
for (const c of merged) {
  if (c.crm_last_call_result && BAD_PHONE_RESULTS.has(c.crm_last_call_result)) c.phone_bad = true
  if (!c.import_status) c.import_status = c.email ? "active" : "no_email"
}

// ---------- report ----------
const counts = {}
for (const c of merged) counts[c.import_status] = (counts[c.import_status] ?? 0) + 1
console.log("========== IMPORT REPORT ==========")
console.log(`raw rows:            ${rawRows.length}`)
console.log(`junk dropped:        ${junkDropped}`)
console.log(`after person-merge:  ${merged.length}  (${mergeLog.length} rows merged in)`)
console.log(`status buckets:`, counts)
console.log(`master-DNC matches:  ${masterSuppressed}`)
console.log(`dead email domains:  ${deadDomains.length}  ${JSON.stringify(deadDomains.slice(0, 10))}`)
console.log(`bad phones (CRM):    ${merged.filter((c) => c.phone_bad).length}`)
console.log(`relationships overlap (flag only): ${relOverlap}`)
console.log(`active-lead flags (${activeLeadFlags.length}):`)
for (const f of activeLeadFlags) console.log(`   ⚠ ${f}`)
console.log(`opt-outs harvested → suppression (${suppressionInserts.length}):`)
for (const o of optOutLog) console.log(`   🚫 ${o}`)
console.log(`merges (${mergeLog.length}):`)
for (const m of mergeLog) console.log(`   ⇒ ${m}`)

if (!commit) {
  console.log("\nDRY RUN — nothing written. Re-run with --commit to import.")
  process.exit(0)
}

// ---------- commit: suppression first, then contacts ----------
console.log("\ncommitting…")
let suppAdded = 0
for (const s of suppressionInserts) {
  const { data: existing } = await sb
    .from("suppression").select("id")
    .eq("source", s.source).eq("source_ref", s.source_ref).limit(1)
  if ((existing ?? []).length > 0) continue
  const { error } = await sb.from("suppression").insert(s)
  if (error) { console.error(`suppression insert failed (${s.source_ref}):`, error.message); process.exit(1) }
  suppAdded++
}
console.log(`suppression rows added: ${suppAdded}`)

const now = new Date().toISOString()
const payload = merged.map((c) => ({
  name: c.name || null,
  first_name: c.first_name,
  last_name: c.last_name,
  email: c.email,
  alt_emails: c.alt_emails ?? [],
  phone: c.phone,
  alt_phones: c.alt_phones ?? [],
  phone_bad: c.phone_bad ?? false,
  property_address: c.property_address,
  status: c.import_status,
  next_touch_at: c.import_status === "active" ? now : null,
  crm_last_call_result: c.crm_last_call_result,
  crm_email_status: c.crm_email_status,
  crm_notes: c.crm_notes,
  import_flags: c.import_flags ?? [],
  raw: c.raw,
}))

// Upsert path: unique index is on lower(email) (partial), which PostgREST
// can't target — so pre-fetch existing identities and only insert new ones.
// PostgREST caps responses at 1000 rows: page through explicitly.
const existingEmails = new Set()
const existingNoEmailKeys = new Set() // name|phone for rows the unique index can't guard
for (let from = 0; ; from += 1000) {
  const { data: page, error: exErr } = await sb
    .from("campaign_contacts")
    .select("email, name, phone")
    .range(from, from + 999)
  if (exErr) { console.error("existing fetch failed:", exErr.message); process.exit(1) }
  for (const r of page) {
    if (r.email) existingEmails.add(r.email)
    else existingNoEmailKeys.add(`${(r.name ?? "").toLowerCase()}|${r.phone ?? ""}`)
  }
  if (page.length < 1000) break
}
const toInsert = payload.filter((p) =>
  p.email
    ? !existingEmails.has(p.email)
    : !existingNoEmailKeys.has(`${(p.name ?? "").toLowerCase()}|${p.phone ?? ""}`)
)
console.log(`contacts to insert: ${toInsert.length} (${payload.length - toInsert.length} already present)`)

for (let i = 0; i < toInsert.length; i += 500) {
  const chunk = toInsert.slice(i, i + 500)
  const { error } = await sb.from("campaign_contacts").insert(chunk)
  if (error) { console.error(`insert chunk ${i} failed:`, error.message); process.exit(1) }
  console.log(`  inserted ${Math.min(i + 500, toInsert.length)}/${toInsert.length}`)
}
console.log("✓ import committed.")
