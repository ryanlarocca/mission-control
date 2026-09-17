#!/usr/bin/env node
/**
 * Import Relationships-table AGENTS into the agent email drip as the
 * `relationships` cohort (Ryan 2026-09-16, rebuild Q3).
 *
 *   node scripts/import-relationships-agents.mjs [--tiers=A,B,C] [--commit] [--json]
 *
 * Who qualifies (all four must hold):
 *   1. relationships.category = 'Agent'  — this drip is agents only. Not
 *      personal relationships, not vendors, not lenders (Ryan, 2026-09-16).
 *   2. tier in --tiers (default A,B,C — the understudy's segmentTiers in
 *      config/campaign-senders.json).
 *   3. has an email that is not already in campaign_contacts (any status —
 *      a bounced/unsubscribed row must NOT be re-imported as fresh) or in
 *      any campaign contact's alt_emails.
 *   4. not on the master suppression list (channel email/all, by email or
 *      phone). The engine re-checks suppression at draft AND send time, so
 *      this is belt-and-braces, not the only stop.
 *
 * Relationships `status` (active / do_not_contact) is deliberately IGNORED:
 * Ryan's standing rule is that Book-of-Business status is rotation cleanup,
 * never an opt-out, and never blocks the drip (agent-email-v2 memo, 2026-07).
 *
 * Rows are inserted as status=active, touch_number=0, next_touch_at=now,
 * cohort='relationships', import_flags=['relationships-import-<date>'],
 * raw={relationships_id, tier, category, source}. The engine's due-list
 * ordering puts Relationships matches ahead of strangers and
 * assignSender() routes them to the understudy, so they trickle out at the
 * understudy's ramp cap (3/day at rung 0) — importing all at once does NOT
 * mean a burst.
 *
 * Dry-run by default: prints the table and writes nothing. --commit inserts.
 * Idempotent: a second run finds every email already present and adds 0.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
for (const line of fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
  if (!m) continue
  let v = m[2]
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (process.env[m[1]] === undefined) process.env[m[1]] = v
}
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

const argv = process.argv.slice(2)
const commit = argv.includes("--commit")
const asJson = argv.includes("--json")
const TIERS = (argv.find((a) => a.startsWith("--tiers="))?.slice(8) ?? "A,B,C").split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)
const TODAY = new Date().toISOString().slice(0, 10)
const IMPORT_FLAG = `relationships-import-${TODAY}`

const normEmail = (e) => String(e ?? "").trim().toLowerCase() || null
const normPhone = (p) => {
  const d = String(p ?? "").replace(/\D/g, "")
  if (!d) return null
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d
}

async function pageAll(build) {
  const out = []
  for (let off = 0; ; off += 1000) {
    const { data, error } = await build().range(off, off + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  return out
}

// --- who is already in the drip (any status) -------------------------------
const existing = await pageAll(() => sb.from("campaign_contacts").select("email, alt_emails, phone"))
const knownEmails = new Set()
const knownPhones = new Set()
for (const c of existing) {
  const e = normEmail(c.email)
  if (e) knownEmails.add(e)
  for (const a of c.alt_emails ?? []) {
    const ae = normEmail(a)
    if (ae) knownEmails.add(ae)
  }
  const p = normPhone(c.phone)
  if (p) knownPhones.add(p)
}

// --- master suppression (same channels the engine reads) --------------------
const supp = await pageAll(() => sb.from("suppression").select("email, phone").in("channel", ["email", "all"]))
const suppEmails = new Set(supp.map((r) => normEmail(r.email)).filter(Boolean))
const suppPhones = new Set(supp.map((r) => normPhone(r.phone)).filter(Boolean))

// --- candidates ---------------------------------------------------------------
const rel = await pageAll(() =>
  sb
    .from("relationships")
    .select("id, name, email, phone, tier, category, status, source")
    .eq("category", "Agent")
    .in("tier", TIERS)
    .not("email", "is", null),
)

const seenThisRun = new Set()
const picked = []
const skipped = { no_email: 0, already_in_drip: 0, phone_in_drip: 0, suppressed: 0, dup_in_relationships: 0 }
for (const r of rel) {
  const email = normEmail(r.email)
  if (!email || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) { skipped.no_email++; continue }
  if (seenThisRun.has(email)) { skipped.dup_in_relationships++; continue }
  const phone = normPhone(r.phone)
  if (knownEmails.has(email)) { skipped.already_in_drip++; continue }
  if (phone && knownPhones.has(phone)) { skipped.phone_in_drip++; continue }
  if (suppEmails.has(email) || (phone && suppPhones.has(phone))) { skipped.suppressed++; continue }
  seenThisRun.add(email)
  const name = String(r.name ?? "").trim()
  const [first, ...rest] = name.split(/\s+/)
  picked.push({
    name: name || email,
    first_name: first || null,
    last_name: rest.join(" ") || null,
    email,
    phone: r.phone ? String(r.phone).trim() : null,
    status: "active",
    touch_number: 0,
    next_touch_at: new Date().toISOString(),
    cohort: "relationships",
    import_flags: [IMPORT_FLAG],
    raw: { relationships_id: r.id, tier: r.tier, category: r.category, relationships_status: r.status, source: r.source ?? null, imported_from: "relationships", imported_at: new Date().toISOString() },
  })
}

const byTier = {}
for (const p of picked) byTier[p.raw.tier] = (byTier[p.raw.tier] || 0) + 1

if (asJson) {
  console.log(JSON.stringify({ commit, tiers: TIERS, candidates: rel.length, picked: picked.length, by_tier: byTier, skipped }, null, 2))
} else {
  console.log(`Relationships agents, tiers ${TIERS.join("/")}: ${rel.length} with an email`)
  console.log(`  skipped — already in drip: ${skipped.already_in_drip}, phone already in drip: ${skipped.phone_in_drip}, suppressed: ${skipped.suppressed}, bad/no email: ${skipped.no_email}, duplicate rows: ${skipped.dup_in_relationships}`)
  console.log(`  to import: ${picked.length}  (${Object.entries(byTier).map(([t, n]) => `${t}=${n}`).join(", ")})`)
  for (const p of picked) console.log(`    ${p.raw.tier}  ${p.name.padEnd(28)} ${p.email}`)
}

if (!commit) {
  console.log(`\nDRY RUN — nothing written. Re-run with --commit to insert ${picked.length} rows as cohort 'relationships'.`)
  process.exit(0)
}
if (!picked.length) {
  console.log("Nothing to import.")
  process.exit(0)
}
let inserted = 0
for (let i = 0; i < picked.length; i += 200) {
  const chunk = picked.slice(i, i + 200)
  const { error } = await sb.from("campaign_contacts").insert(chunk)
  if (error) throw new Error(`insert failed at ${i}: ${error.message}`)
  inserted += chunk.length
}
console.log(`\nInserted ${inserted} contacts (cohort 'relationships', flag ${IMPORT_FLAG}).`)
