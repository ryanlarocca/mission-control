// Phase B cohort picker (2026-08-21): N active agents who never bounced,
// never replied, never unsubscribed, with a brokerage-looking address,
// interleaved by email domain (no single office dominates) and round-robin
// assigned to variants A/B/C. Dry-run by default; --commit tags them
// (cohort='phaseB', variant, sequence reset to touch 0 so they get a fresh
// T1 from the new sender — July's T1 from info@ landed in Spam, so it was
// never really seen).
//
//   node scripts/phaseB-cohort.mjs [--n=60] [--commit]
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
const N = Number(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? 60)
const commit = process.argv.includes("--commit")
const VARIANTS = ["A", "B", "C"]

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

const contacts = await pageAll(() =>
  sb
    .from("campaign_contacts")
    .select("id, name, first_name, email, property_address, import_flags, cohort, status, touch_number")
    .eq("status", "active")
)
const events = await pageAll(() =>
  sb.from("campaign_events").select("contact_id, kind").in("kind", ["bounce", "email_reply", "call_answered", "voicemail"])
)
const touched = new Set(events.map((e) => e.contact_id))
const FREEMAIL = /@(gmail|yahoo|hotmail|aol|outlook|icloud|me|live|msn|comcast|sbcglobal|att)\./i

const eligible = contacts.filter(
  (c) =>
    c.email &&
    !touched.has(c.id) &&
    !c.cohort &&
    c.touch_number <= 1 &&
    (c.first_name || "").trim().length > 1 &&
    !(c.import_flags || []).some((f) => /lead|relationship/i.test(f)) &&
    !FREEMAIL.test(c.email)
)
// Group by domain, deterministic order inside a domain, then interleave
// domains so the 60 spread across many offices.
eligible.sort((a, b) => (a.email.split("@")[1] + a.id).localeCompare(b.email.split("@")[1] + b.id))
const byDomain = new Map()
for (const c of eligible) {
  const d = c.email.split("@")[1].toLowerCase()
  if (!byDomain.has(d)) byDomain.set(d, [])
  byDomain.get(d).push(c)
}
const picked = []
const queues = [...byDomain.values()]
while (picked.length < N && queues.some((q) => q.length)) {
  for (const q of queues) {
    if (picked.length >= N) break
    if (q.length) picked.push(q.shift())
  }
}
picked.forEach((c, i) => (c.variant = VARIANTS[i % 3]))

console.log(
  `eligible ${eligible.length} of ${contacts.length} active; picked ${picked.length} across ${new Set(picked.map((c) => c.email.split("@")[1])).size} domains`
)
const lines = [
  "# Phase B cohort (proposed)",
  "",
  `Picked ${picked.length}. Variants: A = July template, B = short + in-person ask, C = B personalized (brokerage/property).`,
  "",
  "| # | Variant | Name | Email | Property on file |",
  "|---|---|---|---|---|",
]
picked.forEach((c, i) => lines.push(`| ${i + 1} | ${c.variant} | ${c.name} | ${c.email} | ${c.property_address ?? ""} |`))
const out = path.join(REPO_ROOT, "briefs", "tests", "phaseB-cohort.md")
fs.writeFileSync(out, lines.join("\n") + "\n")
console.log(`wrote ${path.relative(REPO_ROOT, out)}`)
const counts = {}
for (const c of picked) counts[c.variant] = (counts[c.variant] || 0) + 1
console.log("variants:", counts)

if (!commit) {
  console.log("dry run — rerun with --commit to tag the cohort")
  process.exit(0)
}
const now = new Date().toISOString()
let n = 0
for (const c of picked) {
  const { error } = await sb
    .from("campaign_contacts")
    .update({ cohort: "phaseB", variant: c.variant, touch_number: 0, next_touch_at: now, updated_at: now })
    .eq("id", c.id)
  if (error) throw new Error(`${c.email}: ${error.message}`)
  n++
}
console.log(`tagged ${n} contacts cohort=phaseB`)
