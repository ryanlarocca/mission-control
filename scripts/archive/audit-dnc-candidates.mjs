#!/usr/bin/env node
// Read-only audit: find leads who said "stop / unsubscribe / remove me / etc"
// but are NOT yet flagged is_dnc=true. Groups by phone+email cluster so we
// count distinct people, not distinct event rows.
//
// Usage: node scripts/audit-dnc-candidates.mjs

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

// Tighter criteria — match opt-out INTENT, not bare substrings. Pure "stop"
// substring matches life-story prose ("I stopped growing"), Google Voice
// footers ("stop=end"), and normal speech ("stop talking"). Each rule below
// requires either a whole-message keyword reply or a multi-word opt-out
// phrase that doesn't show up in normal conversation.
const DNC_RULES = [
  // Twilio-style whole-message keyword replies. Body is JUST the keyword
  // (optionally with punctuation/whitespace).
  { name: "whole-msg STOP",        test: (n) => /^stop[!.?\s]*$/.test(n) },
  { name: "whole-msg UNSUBSCRIBE", test: (n) => /^unsubscribe[!.?\s]*$/.test(n) },
  { name: "whole-msg REMOVE",      test: (n) => /^remove[!.?\s]*$/.test(n) },
  // Multi-word opt-out phrases. "remove me from" + list/mailing/database,
  // "take me off" + list/mailing, "do not contact/call/email me",
  // "please don't contact/call/email me", "stop calling/texting/emailing/mailing/sending"
  // — each only fires on phrasing a real opt-out would use.
  { name: "remove me from … list",  test: (n) => /\bremove (?:me|us|my (?:name|address|number|info)).{0,40}(?:list|mailing|database|records|file|contact)/i.test(n) },
  { name: "take me off … list",     test: (n) => /\btake (?:me|us|my (?:name|address|number|info)).{0,40}(?:list|mailing|database|records|file|contact)/i.test(n) },
  // Cease-contact with finality qualifier — "don't call me again",
  // "do not contact me anymore", "lose my number", "never call me again".
  // The qualifier ("again/anymore/back/ever/in the future") rules out
  // preference phrasing like "don't call me first, text me" (Al Meir) or
  // "don't call me before noon".
  { name: "cease-contact w/ qualifier", test: (n) => /\b(do not|don['’]?t|please don['’]?t|never)\s+(contact|call|text|email|mail|message|reach out to|write)\s+(me|us|this number|my number)\b.{0,40}\b(again|anymore|any more|ever|in the future|going forward|further)\b/i.test(n) },
  { name: "lose my number",         test: (n) => /\blose\s+(my|this)\s+(number|phone)\b/i.test(n) },
  { name: "stop calling / stop emailing me", test: (n) => /\bstop\s+(contacting|calling|texting|emailing|mailing|sending\s+(me\s+)?(letters|mail|emails|texts)|reaching\s+out|messaging|writing\s+(me|to me))\b/i.test(n) },
  { name: "opt out / unsubscribe me", test: (n) => /\b(opt[- ]?out|opt me out|opting out|unsubscribe me)\b/i.test(n) },
]

function looksLikeDnc(text) {
  if (!text) return null
  const n = text.trim()
  if (!n) return null
  for (const rule of DNC_RULES) {
    if (rule.test(n)) return rule.name
  }
  return null
}

// Pull every lead row in pages of 1000.
async function fetchAllLeads() {
  const out = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from("leads")
      .select(
        "id, name, caller_phone, email, lead_type, status, is_dnc, is_junk, is_bad_number, message, ai_notes, ai_summary, source, created_at"
      )
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return out
}

const all = await fetchAllLeads()
console.log(`Loaded ${all.length} lead rows.`)

// Find rows where an inbound text mentions a DNC keyword.
// We only scan inbound surfaces: lead.message (inbound sms/email body) and
// nothing else here. Outbound drip copies live in drip_queue, not leads.message.
const inboundTypes = new Set(["sms", "email", "voicemail", "form", "call"])
const matches = []
for (const r of all) {
  if (!inboundTypes.has(r.lead_type)) continue
  const hit = looksLikeDnc(r.message)
  if (hit) matches.push({ row: r, hit })
}

console.log(`\n${matches.length} inbound rows contain a DNC keyword.`)

// Cluster by phone || email (matches the MC card-grouping logic). Skip
// clusters where ANY row in the cluster already has is_dnc=true — those are
// already handled.
const clusterKey = (r) => r.caller_phone || (r.email ? r.email.toLowerCase() : `id:${r.id}`)

const clusterMatches = new Map() // key -> { rows: [matching], anyDnc: bool, sampleHit, name }
for (const { row, hit } of matches) {
  const k = clusterKey(row)
  if (!clusterMatches.has(k)) clusterMatches.set(k, { rows: [], hit, key: k })
  clusterMatches.get(k).rows.push(row)
}

// For each cluster, fetch ALL rows to know if it's already DNC'd anywhere.
const clusterStatus = []
for (const [key, c] of clusterMatches) {
  // Find any row in `all` sharing the same cluster key.
  const allInCluster = all.filter((r) => clusterKey(r) === key)
  const anyDnc = allInCluster.some((r) => r.is_dnc === true)
  const anyJunk = allInCluster.some((r) => r.is_junk === true)
  const name = allInCluster.map((r) => r.name).find(Boolean) || null
  clusterStatus.push({ key, hit: c.hit, name, anyDnc, anyJunk, matchRows: c.rows, allInCluster })
}

const notYetDnc = clusterStatus.filter((c) => !c.anyDnc)
const alreadyDnc = clusterStatus.filter((c) => c.anyDnc)

console.log(`\n── Cluster summary ──`)
console.log(`  ${clusterStatus.length} distinct people sent a DNC-keyword message`)
console.log(`  ${alreadyDnc.length} already flagged is_dnc=true (no action needed)`)
console.log(`  ${notYetDnc.length} NOT YET flagged — candidates for DNC`)

console.log(`\n── Candidates (${notYetDnc.length}) ──`)
notYetDnc.sort((a, b) => {
  const at = new Date(a.matchRows[0].created_at).getTime()
  const bt = new Date(b.matchRows[0].created_at).getTime()
  return bt - at
})
for (const c of notYetDnc) {
  const r = c.matchRows[0]
  const msg = (r.message || "").replace(/\s+/g, " ").slice(0, 90)
  console.log(
    `  ${r.created_at}  ${c.key.padEnd(20)}  keyword="${c.hit}"  status=${r.status}  junk=${c.anyJunk}`
  )
  console.log(`    name=${c.name || "—"}  type=${r.lead_type}  source=${r.source || "—"}`)
  console.log(`    msg: "${msg}${(r.message || "").length > 90 ? "…" : ""}"`)
}

// Emit a machine-readable summary so the executor script can read it.
const out = {
  generated_at: new Date().toISOString(),
  total_lead_rows: all.length,
  total_inbound_keyword_rows: matches.length,
  total_clusters_with_keyword: clusterStatus.length,
  already_dnc_clusters: alreadyDnc.length,
  candidate_clusters: notYetDnc.length,
  candidates: notYetDnc.map((c) => ({
    key: c.key,
    name: c.name,
    keyword: c.hit,
    rep_lead_id: c.matchRows[0].id,
    rep_created_at: c.matchRows[0].created_at,
    rep_message: c.matchRows[0].message,
    all_lead_ids: c.allInCluster.map((r) => r.id),
  })),
}
import("node:fs").then((fs) => {
  fs.writeFileSync(
    new URL("./audit-dnc-candidates.json", import.meta.url),
    JSON.stringify(out, null, 2)
  )
  console.log(`\nWrote scripts/audit-dnc-candidates.json`)
})
