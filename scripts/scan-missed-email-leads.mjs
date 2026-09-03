#!/usr/bin/env node
// Find inbound seller emails sitting in the LRG mailboxes that never became a
// lead row in the CRMS.
//
// Why this exists: lead capture only started 2026-04-28. Virginia Slater wrote
// to ryansvj@ on 2025-12-15 about 555 Nido Dr and was never ingested — Ryan
// found it by hand on 2026-09-02. Anything that arrived before the cutover, or
// while the watcher was down, is invisible to the Leads tab.
//
// Read-only against Gmail (list/get only). Writes scripts/.missed-lead-scan.json.
//
//   node scripts/scan-missed-email-leads.mjs                  # since 2025-01-01
//   node scripts/scan-missed-email-leads.mjs --since 2024-01-01
//   node scripts/scan-missed-email-leads.mjs --mailbox ryan@lrghomes.com
//   node scripts/scan-missed-email-leads.mjs --wide            # drop keyword prefilter
//
// Only 5 lrghomes.com mailboxes actually exist (probed 2026-09-02); the old
// ryansva/ryansvd "shell seats" are aliases, not accounts, and 401 on
// impersonation. The two personal boxes (ryan@ 61k msgs, info@ 10k) are far too
// big to walk message-by-message, so the seller keywords are pushed into the
// Gmail query and run server-side.
import fs from "node:fs"
import path from "node:path"
import { google } from "googleapis"

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
const H = { apikey: env.LRG_SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.LRG_SUPABASE_SERVICE_KEY}` }

const args = process.argv.slice(2)
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
const SINCE = opt("--since") || "2025-01-01"
const WIDE = args.includes("--wide")
const ONLY = opt("--mailbox")

// Campaign mailboxes are small enough to walk in full; the personal boxes are
// keyword-filtered server-side or they take hours.
const MAILBOXES = [
  { addr: "ryansvg@lrghomes.com", small: true },
  { addr: "ryansvj@lrghomes.com", small: true },
  { addr: "ryansvr@lrghomes.com", small: true },
  { addr: "info@lrghomes.com", small: false },
  { addr: "ryan@lrghomes.com", small: false },
].filter((m) => !ONLY || m.addr === ONLY)

// Seller-intent terms, used both as the Gmail-side prefilter for the big
// mailboxes and as the local filter for the small ones.
const TERMS = [
  "property", "properties", "house", "home", "duplex", "triplex", "fourplex",
  "four plex", "multifamily", "multi-family", "apartment", "selling", "sell",
  "cash offer", "all cash", "quick close", "mailer", "postcard", "your letter",
  "free quote", "valuation", "appraisal", "market value", "interested in selling",
  "still available", "how much", "my land", "vacant lot", "inherited", "probate",
]
const gmailTerms = "(" + TERMS.map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" OR ") + ")"
const SIGNAL = new RegExp("\\b(" + [
  "propert", "hous(e|ing)", "home", "duplex", "triplex", "four ?plex", "multi ?family",
  "apartment", "sell(ing)?", "sale", "offer", "cash", "quote", "valuation", "apprais",
  "market value", "letter", "mailer", "postcard", "interested", "equity", "acre",
  "lot", "inherit", "probate", "trust", "estate", "tenant", "rental", "escrow",
].join("|") + ")\\b", "i")

// Machine noise / vendors we never want in the report.
const NOISE = /(mailer-daemon|no-?reply|noreply|postmaster|notification|support@|billing@|receipt|do-?not-?reply|@accounts\.google|@google\.com|@docusign|@zillow|@redfin|@realtor\.com|@linkedin|@intuit|@paypal|@stripe|@amazon|@ebay|@apple\.com|@microsoft|@godaddy|@squarespace|@mailchimp|@constantcontact|unsubscribe@|@twilio|@vercel|@github|@slack|@dropbox|@indeed|@ziprecruiter|@yelp|@nextdoor|@costco|@chase|@bankofamerica|@wellsfargo|@usbank|@fidelity|@vanguard|@irs\.gov|@ftb\.ca\.gov|calendar-notification|@meetup|@eventbrite|@substack|@medium|@quora|@pinterest|@instagram|@facebook|@twitter|@tiktok|@youtube|@netflix|@spotify|@uber|@lyft|@doordash|@instacart)/i

function getGmail(userEmail) {
  const c = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY)
  return google.gmail({
    version: "v1",
    auth: new google.auth.JWT({
      email: c.client_email,
      key: c.private_key,
      // Must match the scope granted in Workspace domain-wide delegation
      // exactly — `gmail.readonly` is NOT on the allowlist and 401s.
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      subject: userEmail,
    }),
  })
}
const hdr = (m, n) => (m.payload?.headers || []).find((h) => h.name.toLowerCase() === n)?.value || ""
function bodyText(p) {
  if (!p) return ""
  if (p.body?.data) return Buffer.from(p.body.data, "base64").toString("utf-8")
  for (const x of p.parts || []) if (x.mimeType === "text/plain" && x.body?.data) return Buffer.from(x.body.data, "base64").toString("utf-8")
  for (const x of p.parts || []) { const t = bodyText(x); if (t) return t }
  return ""
}
const addrOf = (s) => (s.match(/<([^>]+)>/)?.[1] || s).trim().toLowerCase()

// ---------- what the CRMS already has ----------
let leads = []
for (let o = 0; ; o += 1000) {
  const r = await fetch(`${SB}/rest/v1/leads?select=id,created_at,name,email,gmail_thread_id,caller_phone,status&order=created_at.asc`, { headers: { ...H, Range: `${o}-${o + 999}` } })
  const j = await r.json()
  leads.push(...j)
  if (j.length < 1000) break
}
const knownEmails = new Set(leads.map((l) => (l.email || "").toLowerCase()).filter(Boolean))
const knownThreads = new Set(leads.map((l) => l.gmail_thread_id).filter(Boolean))
const CUTOVER = "2026-04-28"

console.log(`${leads.length} lead rows — ${knownEmails.size} known senders, ${knownThreads.size} known threads`)
console.log(`Scanning ${MAILBOXES.length} mailbox(es) since ${SINCE}\n`)

const misses = []
const errors = []

for (const { addr, small } of MAILBOXES) {
  let gmail
  try { gmail = getGmail(addr) } catch (e) { errors.push({ addr, error: e.message }); continue }
  // Inbound only; anything from our own domain is drip/self-send noise.
  const q = [
    `after:${SINCE.replace(/-/g, "/")}`,
    "-from:lrghomes.com",
    "-in:chats",
    "category:primary OR category:personal OR -category:promotions",
    small || WIDE ? "" : gmailTerms,
  ].filter(Boolean).join(" ")

  let pageToken = null, scanned = 0, hits = 0
  process.stdout.write(`${addr.padEnd(24)} `)
  try {
    do {
      const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 500, pageToken: pageToken || undefined })
      for (const m of list.data.messages || []) {
        scanned++
        if (knownThreads.has(m.threadId)) continue
        const msg = (await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" })).data
        const from = hdr(msg, "from")
        const sender = addrOf(from)
        if (sender.endsWith("@lrghomes.com") || NOISE.test(from)) continue
        if (knownEmails.has(sender)) continue
        const subject = hdr(msg, "subject")
        const body = bodyText(msg.payload).slice(0, 4000)
        if (!WIDE && !SIGNAL.test(`${subject}\n${body}`)) continue
        const date = new Date(Number(msg.internalDate)).toISOString()
        hits++
        misses.push({
          mailbox: addr, date, preCutover: date < CUTOVER, from, sender, subject,
          threadId: msg.threadId,
          snippet: (msg.snippet || "").replace(/\s+/g, " ").slice(0, 300),
          body: body.replace(/\s+/g, " ").slice(0, 800),
        })
      }
      pageToken = list.data.nextPageToken
      if (scanned > 8000) break // safety valve on the 61k-message personal box
    } while (pageToken)
    console.log(`scanned ${String(scanned).padStart(5)} → ${hits} uncaptured`)
  } catch (e) {
    console.log(`ERROR ${e.message.split("\n")[0].slice(0, 70)}`)
    errors.push({ addr, error: e.message.split("\n")[0] })
  }
}

misses.sort((a, b) => a.date.localeCompare(b.date))
fs.writeFileSync("scripts/.missed-lead-scan.json", JSON.stringify({ scannedAt: new Date().toISOString(), since: SINCE, errors, misses }, null, 1))

console.log(`\n${"=".repeat(80)}`)
console.log(`${misses.length} uncaptured inbound email(s) — ${misses.filter((m) => m.preCutover).length} predate the ${CUTOVER} capture cutover`)
if (errors.length) console.log(`errors: ${JSON.stringify(errors)}`)
console.log("=".repeat(80))
for (const m of misses) {
  console.log(`\n[${m.date.slice(0, 10)}]${m.preCutover ? " PRE-CUTOVER" : ""} → ${m.mailbox}`)
  console.log(`  from:    ${m.from}`)
  console.log(`  subject: ${m.subject}`)
  console.log(`  ${m.snippet.slice(0, 200)}`)
}
console.log(`\n→ scripts/.missed-lead-scan.json`)
