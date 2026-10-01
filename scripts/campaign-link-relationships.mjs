#!/usr/bin/env node
/**
 * One-time (re-runnable) backfill: link campaign_contacts to the Relationships
 * card that already exists for the same person — by phone (last 10 digits)
 * first, then by email. Agents line + email replies keep the link current
 * from 2026-10-01 on (lib/agentsLineInbound.ts); this seeds it.
 *
 *   node scripts/campaign-link-relationships.mjs            # dry run (report only)
 *   node scripts/campaign-link-relationships.mjs --apply    # write relationship_id
 *
 * Never creates cards, never overwrites an existing link, prefers an active
 * card over do_not_contact when a number/email matches more than one.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
for (const line of fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf-8").split(/\r?\n/)) {
  const eq = line.indexOf("=")
  if (eq < 0 || line.trim().startsWith("#")) continue
  const key = line.slice(0, eq).trim()
  let val = line.slice(eq + 1).trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
  if (process.env[key] === undefined) process.env[key] = val
}
const apply = process.argv.includes("--apply")
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

async function all(table, cols) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return rows
}
const d10 = (p) => String(p ?? "").replace(/\D/g, "").slice(-10)
const lc = (e) => String(e ?? "").trim().toLowerCase()

const rels = await all("relationships", "id, name, phone, email, status")
const byPhone = new Map()
const byEmail = new Map()
const prefer = (cur, r) => (!cur || (cur.status !== "active" && r.status === "active") ? r : cur)
for (const r of rels) {
  const p = d10(r.phone)
  if (p.length === 10) byPhone.set(p, prefer(byPhone.get(p), r))
  const e = lc(r.email)
  if (e.includes("@")) byEmail.set(e, prefer(byEmail.get(e), r))
}

const contacts = await all("campaign_contacts", "id, name, phone, alt_phones, email, alt_emails, relationship_id")
let linked = 0, already = 0, viaPhone = 0, viaEmail = 0, none = 0
const sample = []
for (const c of contacts) {
  if (c.relationship_id) { already++; continue }
  let rel = null, how = ""
  for (const p of [c.phone, ...(c.alt_phones ?? [])]) {
    const r = byPhone.get(d10(p))
    if (r) { rel = r; how = "phone"; break }
  }
  if (!rel) {
    for (const e of [c.email, ...(c.alt_emails ?? [])]) {
      const r = byEmail.get(lc(e))
      if (r) { rel = r; how = "email"; break }
    }
  }
  if (!rel) { none++; continue }
  if (how === "phone") viaPhone++; else viaEmail++
  if (sample.length < 8) sample.push(`${c.name ?? c.email} → ${rel.name} [${how}${rel.status !== "active" ? `, ${rel.status}` : ""}]`)
  if (apply) {
    const { error } = await sb.from("campaign_contacts").update({ relationship_id: rel.id, updated_at: new Date().toISOString() }).eq("id", c.id)
    if (error) { console.error(`✗ ${c.id}: ${error.message}`); continue }
  }
  linked++
}
console.log(`${apply ? "LINKED" : "WOULD LINK"} ${linked} campaign contacts (${viaPhone} by phone, ${viaEmail} by email) · ${already} already linked · ${none} with no card · ${contacts.length} total`)
for (const s of sample) console.log("  " + s)
if (!apply) console.log("dry run — re-run with --apply to write")
