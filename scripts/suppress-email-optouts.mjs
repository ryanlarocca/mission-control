#!/usr/bin/env node
// Phase 0 of briefs/BRIEF_LEAD_RECOVERY_2026-09-02.md.
//
// Fourteen people asked in writing to stop being contacted and none of them
// were ever suppressed — their requests arrived by email and the CRMS only
// ingests from the campaign mailboxes. Three of them (Fogelstrom, Ernst,
// Carter) were still `status=active` in campaign_contacts on 2026-09-02, i.e.
// queued to be mailed again.
//
// Writes to `suppression`, the master list. scripts/campaign-engine.mjs checks
// it at draft time (:325) and re-checks at send time (:553), so an entry here
// is the non-bypassable stop. Channel "all" — they asked to be removed from
// mail, so we don't keep emailing either.
//
// Every entry below was read in full and classified by hand from
// scripts/.missed-lead-scan.json. Deliberately EXCLUDED as false positives:
//   • Dana Adams (wholesaler describing her own deal flow)
//   • Philip Adishian (Ryan's own direct-mail print vendor)
//   • "michael Jacob's" via ryanlarocca44@gmail.com (Ryan's own intake test)
//   • Kyung Kim, Jeanne Mccarry (declined to sell; never asked to be removed —
//     Kyung Kim in fact invited a call)
//
//   node scripts/suppress-email-optouts.mjs            # dry run
//   node scripts/suppress-email-optouts.mjs --write
import fs from "node:fs"
import path from "node:path"

const envPath = [
  path.join(process.cwd(), ".env.local"),
  "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local",
].find((p) => fs.existsSync(p))
const env = {}
for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "")
}
const SB = env.LRG_SUPABASE_URL
const H = {
  apikey: env.LRG_SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.LRG_SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
}
const WRITE = process.argv.includes("--write")
const SOURCE = "email_optout_scan_2026-09-02"

// email/phone normalization must match lib/suppression.ts exactly:
// email lowercased+trimmed, phone reduced to its last 10 digits.
const normEmail = (s) => (s ? String(s).trim().toLowerCase() : null)
const normPhone = (s) => {
  const d = String(s ?? "").replace(/\D/g, "")
  return d.length >= 10 ? d.slice(-10) : null
}

const ENTRIES = [
  // ---- property owners responding to the direct mail ----
  { ref: "grundstrom-junewood", audience: "seller", name: "Maydean Grundstrom", email: "megefg@sbcglobal.net",
    site_address: "Junewood Ave, San Jose, CA", reason: "2025-08-02 email: 'PLEASE TAKE OUR NAME OFF OF YOUR MAILING LIST'" },
  { ref: "roseanna-4083776628", audience: "seller", name: null, phone: "408-377-6628",
    site_address: "1552 Rose Anna Dr, San Jose, CA", reason: "2025-08-21 text: 'PLEASE STOP SENDING ME A LETTER ... STOP!'" },
  { ref: "aiello-helen-millbrae", audience: "seller", name: "Peter Aiello", email: "peteraiellore@gmail.com",
    site_address: "1169 Helen Drive, Millbrae, CA", reason: "2026-03-06 email: 'Please remove me from your mailing list'" },
  { ref: "korek-hamilton-losaltos", audience: "seller", name: "Brian Korek", email: "brian@korek.com",
    site_address: "132 Hamilton Ct, Los Altos, CA 94022", reason: "2026-03-07 email: 'Please remove me from your mailing list and any partner lists' (perpetual trust, will never be sold)" },
  { ref: "dsj-bailey-ave", audience: "seller", name: "Candace Berenguer (Roman Catholic Bishop of San Jose)", email: "candace.hamill@dsj.org", phone: "408-294-8953",
    site_address: "2570 Bailey Ave, San Jose, CA", reason: "2026-03-09 email 'Remove from Mailing List': 'please take us off your mailing list'" },
  { ref: "flores-1704-hester", audience: "seller", name: "Miss Flores", phone: "408-675-9095",
    site_address: "1704 Hester, San Jose, CA", reason: "2025-03-15 text: 'please take me off your mailing list ... we do not ever plan to sell'" },
  { ref: "teixeira-russo-drive", audience: "seller", name: "Donald Teixeira, Trustee", email: "bazerkly@sbcglobal.net",
    site_address: "5382 Russo Drive, San Jose, CA 95118", reason: "2025-06-30 email 'Not For Sale': 'Please take me off your mailing list'" },
  { ref: "tran-tymn-way", audience: "seller", name: "Lisa Tran", email: "poohbear00k@hotmail.com",
    site_address: "1983 Tymn Way, San Jose, CA 95122", reason: "2025-08-05 email: 'remove & delete LISA TRAN and/or ANY & ALL PERSONS from ALL your mailing lists'; states address is also on the DO NOT MAIL list" },
  { ref: "diers-ramona-paloalto", audience: "seller", name: "Linda Diers", email: "lindadiers@yahoo.com",
    site_address: "2460 Ramona St, Palo Alto, CA", reason: "2026-03-17 email 'Remove from list': 'please remove me from your mailing list'" },

  // ---- agents from the info@ outreach campaign ----
  { ref: "jadallah-agent", audience: "agent", name: "Matt Jadallah", email: "matt.jadallah@cbrealty.com",
    reason: "2025-11-18 email: 'No thank you and please do not contact me' / 'Never subscribed. Stop spamming people'" },
  { ref: "golovko-agent", audience: "agent", name: "Olga Golovko", email: "experts@golovkohomes.com", phone: "650-409-6542",
    reason: "2026-03-05 email: 'Please take me off your mailing lists'" },
  { ref: "fogelstrom-agent", audience: "agent", name: "Carole Fogelstrom", email: "carole@carolefogelstrom.com", phone: "650-892-1534",
    reason: "2026-03-07 email: 'you can remove me from your email list' (retired)" },
  { ref: "ernst-agent", audience: "agent", name: "Maryann Ernst", email: "maryann@maryannernst.com", phone: "415-361-9921",
    reason: "2026-04-14 email: 'Ryan please remove me from your list'" },
  { ref: "carter-agent", audience: "agent", name: "Kristina Carter", email: "kristinacarterre@gmail.com",
    reason: "2026-04-21 email: 'Remove me from your list.'" },
]

const existing = await (await fetch(`${SB}/rest/v1/suppression?select=id,email,phone,source,source_ref`, { headers: H })).json()
const bySourceRef = new Set(existing.filter((e) => e.source === SOURCE).map((e) => e.source_ref))
const supEmails = new Set(existing.map((e) => normEmail(e.email)).filter(Boolean))
const supPhones = new Set(existing.map((e) => e.phone).filter(Boolean))

console.log(`suppression currently holds ${existing.length} rows`)
console.log(`${WRITE ? "WRITING" : "DRY RUN — pass --write to apply"}\n`)

let inserted = 0, skipped = 0
for (const e of ENTRIES) {
  const email = normEmail(e.email)
  const phone = normPhone(e.phone)
  if (!email && !phone) { console.log(`  !! ${e.ref}: no email or phone — skipped`); continue }
  const already = bySourceRef.has(e.ref) || (email && supEmails.has(email)) || (phone && supPhones.has(phone))
  if (already) { console.log(`  = already suppressed: ${e.name || phone}`); skipped++; continue }

  const row = {
    email, phone, name: e.name ?? null,
    site_address: e.site_address ?? null,
    reason: e.reason,
    source: SOURCE,
    source_ref: e.ref,
    channel: "all",
    audience: e.audience,
  }
  if (!WRITE) { console.log(`  + would suppress [${e.audience}] ${e.name || phone} — ${email || phone}`); inserted++; continue }
  const res = await fetch(`${SB}/rest/v1/suppression`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(row) })
  if (!res.ok) { console.log(`  ✗ ${e.ref} → ${res.status} ${await res.text()}`); continue }
  console.log(`  + suppressed [${e.audience}] ${e.name || phone}`)
  inserted++
}

// The three that were still queued to receive mail. Suppression alone stops
// the send, but leaving them `active` misrepresents the list — mark them
// unsubscribed so the roster matches reality.
const STILL_ACTIVE = ["carole@carolefogelstrom.com", "maryann@maryannernst.com", "kristinacarterre@gmail.com"]
console.log("")
for (const em of STILL_ACTIVE) {
  const rows = await (await fetch(`${SB}/rest/v1/campaign_contacts?email=ilike.${encodeURIComponent(em)}&select=id,name,status`, { headers: H })).json()
  const c = Array.isArray(rows) ? rows[0] : null
  if (!c) { console.log(`  campaign_contacts: ${em} not found`); continue }
  if (c.status !== "active") { console.log(`  campaign_contacts: ${c.name} already ${c.status}`); continue }
  if (!WRITE) { console.log(`  ~ would set campaign_contacts ${c.name} active → unsubscribed`); continue }
  const res = await fetch(`${SB}/rest/v1/campaign_contacts?id=eq.${c.id}`, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify({ status: "unsubscribed" }) })
  console.log(res.ok ? `  ~ ${c.name}: active → unsubscribed` : `  ✗ ${c.name} → ${res.status} ${await res.text()}`)
}

console.log(`\n${WRITE ? "done" : "dry run"}: ${inserted} to suppress, ${skipped} already present`)
