// One-off, 2026-09-23. The 2026-05-22 phone-book import tagged 35 contacts
// with the Relationships "Seller" category. Ryan: "these are more leads than
// anything" — move them to the Leads tab. Stephanie Tc (transaction
// coordinator) stays as a Vendor. Everyone else:
//   - has a leads row already (phone match)  → just delete the relationship
//   - no leads row, status active            → new lead, status nurture
//   - no leads row, status do_not_contact    → new lead, status dead
//     (the DNC verdicts came from the cleanup pass, not opt-outs)
// Backup of the 35 rows is written before anything is deleted.
//   node scripts/move-sellers-to-leads-2026-09-23.mjs [--apply]
import fs from "node:fs"
import path from "node:path"

const envPath = fs.existsSync(".env.local") ? ".env.local" : "../../../.env.local"
for (const l of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const URL_ = process.env.LRG_SUPABASE_URL
const KEY = process.env.LRG_SUPABASE_SERVICE_KEY
const APPLY = process.argv.includes("--apply")
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" }

async function rest(method, p, body) {
  const r = await fetch(`${URL_}/rest/v1/${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}
const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10)
const e164 = (p) => `+1${last10(p)}`

// "Pam 502 Lavern 117 Beth" → "502 Lavern 117 Beth"; "David Poplar" → null
function addressFromName(name) {
  const m = name.match(/\b\d{2,5}\s+(?:\d+(?:st|nd|rd|th)\b|[A-Za-z]).*$/)
  return m ? m[0].trim() : null
}

const sellers = await rest("GET", "relationships?category=eq.Seller&select=*&order=name")
console.log(`Seller-category rows: ${sellers.length}`)

const backupDir = path.resolve("../../../../comprehensive-relationship-management/data")
const backup = path.join(fs.existsSync(backupDir) ? backupDir : "/tmp", "seller-move-backup-2026-09-23.json")
fs.writeFileSync(backup, JSON.stringify(sellers, null, 2))
console.log(`Backup → ${backup}`)

const phones = sellers.map((r) => e164(r.phone))
const leads = await rest("GET", `leads?select=id,name,caller_phone,status&caller_phone=in.(${phones.map((p) => `"${encodeURIComponent(p)}"`).join(",")})`)
const leadsByPhone = new Map()
for (const l of leads) {
  const k = last10(l.caller_phone)
  leadsByPhone.set(k, [...(leadsByPhone.get(k) || []), l])
}

const plan = []
for (const r of sellers) {
  if (r.name.trim() === "Stephanie Tc") {
    plan.push({ r, action: "recategorize:Vendor" })
    continue
  }
  const existing = leadsByPhone.get(last10(r.phone)) || []
  if (existing.length) {
    plan.push({ r, action: "delete-only", existing: existing.map((l) => `${l.status}`).join("/") })
  } else {
    plan.push({
      r,
      action: "create+delete",
      lead: {
        source: "Phone book",
        lead_type: "sms",
        caller_phone: e164(r.phone),
        name: r.name,
        email: r.email || null,
        status: r.status === "do_not_contact" ? "dead" : "nurture",
        property_address: addressFromName(r.name),
        notes: [r.notes?.trim(), `[Moved from Relationships (Seller, tier ${r.tier}) on 2026-09-23]`].filter(Boolean).join("\n\n"),
        created_at: r.created_at,
      },
    })
  }
}

for (const p of plan) {
  const extra = p.action === "delete-only" ? `(lead: ${p.existing})` : p.lead ? `→ ${p.lead.status}${p.lead.property_address ? `, addr "${p.lead.property_address}"` : ""}` : ""
  console.log(`${p.action.padEnd(20)} ${p.r.name} ${extra}`)
}
const counts = plan.reduce((a, p) => ((a[p.action] = (a[p.action] || 0) + 1), a), {})
console.log("plan:", counts)

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to execute.")
  process.exit(0)
}

let created = 0, deleted = 0
for (const p of plan) {
  if (p.action === "recategorize:Vendor") {
    await rest("PATCH", `relationships?id=eq.${p.r.id}`, { category: "Vendor" })
    continue
  }
  if (p.action === "create+delete") {
    await rest("POST", "leads", p.lead)
    created++
  }
  await rest("DELETE", `relationships?id=eq.${p.r.id}`)
  deleted++
}
const remaining = await rest("GET", "relationships?category=eq.Seller&select=id")
console.log(`\nDone. leads created: ${created}, relationships deleted: ${deleted}, Seller rows remaining: ${remaining.length}`)
