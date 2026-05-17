#!/usr/bin/env node
// Wider read-only audit: surface every lead cluster that isn't already
// is_dnc=true but has SOME signal of opt-out / unwilling sentiment in an
// inbound surface (message body, ai_notes, suggested_status_reason,
// followup_reason). Bucketed by signal strength so we can walk them.
//
// Buckets:
//   strong   — explicit list-removal / cease-contact / Twilio keyword
//   soft     — "not interested", "not selling", "no thanks", hostile,
//              legal threats, "wrong person/owner/tenant only"
//   ai_hint  — AI fields (ai_notes / suggested_status_reason) flagged
//              the lead as unwilling even if the raw message didn't
//
// Usage: node scripts/audit-dnc-wide.mjs

import { createClient } from "@supabase/supabase-js"
import { readFileSync, writeFileSync } from "node:fs"

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

const STRONG_RULES = [
  { name: "whole-msg STOP",        test: (n) => /^stop[!.?\s]*$/i.test(n) },
  { name: "whole-msg UNSUBSCRIBE", test: (n) => /^unsubscribe[!.?\s]*$/i.test(n) },
  { name: "whole-msg REMOVE",      test: (n) => /^remove[!.?\s]*$/i.test(n) },
  { name: "remove me from … list",  test: (n) => /\bremove (?:me|us|my (?:name|address|number|info)).{0,40}(?:list|mailing|database|records|file|contact)/i.test(n) },
  { name: "take me off … list",     test: (n) => /\btake (?:me|us|my (?:name|address|number|info)).{0,40}(?:list|mailing|database|records|file|contact)/i.test(n) },
  { name: "cease-contact w/ qualifier", test: (n) => /\b(do not|don['’]?t|please don['’]?t|never)\s+(contact|call|text|email|mail|message|reach out to|write)\s+(me|us|this number|my number)\b.{0,40}\b(again|anymore|any more|ever|in the future|going forward|further)\b/i.test(n) },
  { name: "lose my number",         test: (n) => /\blose\s+(my|this)\s+(number|phone)\b/i.test(n) },
  { name: "stop calling / mailing / etc me", test: (n) => /\bstop\s+(contacting|calling|texting|emailing|mailing|sending\s+(me\s+)?(letters|mail|emails|texts)|reaching\s+out|messaging|writing\s+(me|to me))\b/i.test(n) },
  { name: "opt out / unsubscribe me", test: (n) => /\b(opt[- ]?out|opt me out|opting out|unsubscribe me)\b/i.test(n) },
]

const SOFT_RULES = [
  // Refusal to sell — common explicit phrasings.
  { name: "not selling / not for sale", test: (n) => /\b(not (?:selling|for sale|interested in selling)|no (?:plans|intention|interest)\s+(?:to|of|in)\s+(?:sell|selling)|never\s+(?:sell|going to sell)|will not sell|won['’]t sell)\b/i.test(n) },
  { name: "not interested", test: (n) => /\b(not interested|no interest|no thank ?you|no thanks|i'?m good|we'?re good|pass|no thanks)\b/i.test(n) },
  // Hostile / harassment language.
  { name: "leave me alone / harassment", test: (n) => /\b(leave me alone|stop bothering|stop harassing|quit (?:calling|texting|emailing|mailing|bothering)|you'?re harassing|this is harassment)\b/i.test(n) },
  { name: "profanity / hostile", test: (n) => /\b(fuck off|fuck you|piss off|go away|get lost|bug off|buzz off)\b/i.test(n) },
  // Legal threats.
  { name: "legal threat", test: (n) => /\b(cease and desist|my attorney|my lawyer|file a (?:lawsuit|complaint|report)|report you to|reporting (?:you|this) to|FCC|FTC|attorney general)\b/i.test(n) },
  // Wrong owner / wrong person.
  { name: "wrong person / not the owner", test: (n) => /\b(wrong (?:number|person)|i'?m not the owner|not my (?:house|property)|i'?m (?:just )?(?:a |the )?(?:tenant|renter)|owner (?:doesn['’]t|does not)|owner passed|owner is deceased|i don['’]t own|never owned)\b/i.test(n) },
  // Deceased / estate-only signal.
  { name: "deceased owner", test: (n) => /\b(deceased|passed away|is dead|has died)\b/i.test(n) },
  // Generic "no" with finality near a contact verb.
  { name: "no please … contact/mail", test: (n) => /\b(no thank you|no thanks|please no more|no more (?:letters|mail|emails|calls|texts))\b/i.test(n) },
]

function classify(text) {
  if (!text) return null
  const n = text.trim()
  if (!n) return null
  for (const r of STRONG_RULES) if (r.test(n)) return { bucket: "strong", rule: r.name }
  for (const r of SOFT_RULES) if (r.test(n)) return { bucket: "soft", rule: r.name }
  return null
}

async function fetchAllLeads() {
  const out = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from("leads")
      .select(
        "id, name, caller_phone, email, lead_type, status, is_dnc, is_junk, is_bad_number, message, ai_notes, suggested_status, suggested_status_reason, followup_reason, source, created_at"
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

const clusterKey = (r) => r.caller_phone || (r.email ? r.email.toLowerCase() : `id:${r.id}`)

// First pass: classify each row across MULTIPLE surfaces.
const rowHits = []
for (const r of all) {
  const surfaces = [
    { field: "message", text: r.message },
    { field: "ai_notes", text: r.ai_notes },
    { field: "suggested_status_reason", text: r.suggested_status_reason },
    { field: "followup_reason", text: r.followup_reason },
  ]
  let best = null
  for (const s of surfaces) {
    const c = classify(s.text)
    if (c && (!best || (best.bucket === "soft" && c.bucket === "strong"))) {
      best = { ...c, field: s.field, snippet: s.text }
    }
  }
  if (best) rowHits.push({ row: r, ...best })
}

// Cluster.
const clusters = new Map()
for (const h of rowHits) {
  const k = clusterKey(h.row)
  if (!clusters.has(k)) clusters.set(k, [])
  clusters.get(k).push(h)
}

// For each cluster, check is_dnc anywhere.
const summary = []
for (const [key, hits] of clusters) {
  const allInCluster = all.filter((r) => clusterKey(r) === key)
  const anyDnc = allInCluster.some((r) => r.is_dnc === true)
  const anyJunk = allInCluster.some((r) => r.is_junk === true)
  const name = allInCluster.map((r) => r.name).find(Boolean) || null
  // Pick the strongest hit for the cluster header
  const strongest = hits.find((h) => h.bucket === "strong") || hits[0]
  summary.push({ key, name, anyDnc, anyJunk, hits, strongest, allInCluster })
}

const strong  = summary.filter((c) => !c.anyDnc && c.hits.some((h) => h.bucket === "strong"))
const soft    = summary.filter((c) => !c.anyDnc && !c.hits.some((h) => h.bucket === "strong"))
const already = summary.filter((c) =>  c.anyDnc)

const fmtRow = (h) => {
  const r = h.row
  const snip = (h.snippet || "").replace(/\s+/g, " ").slice(0, 160)
  return `    [${r.created_at.slice(0,10)}] ${r.lead_type.padEnd(9)} status=${r.status.padEnd(10)} field=${h.field}  rule="${h.rule}"
      "${snip}${(h.snippet || "").length > 160 ? "…" : ""}"`
}

const hr = "━".repeat(78)
console.log("")
console.log(hr)
console.log(`STRONG candidates (explicit opt-out, not yet DNC'd): ${strong.length}`)
console.log(hr)
for (const c of strong) {
  console.log(`\n● ${c.key}  name=${c.name || "—"}  junk=${c.anyJunk}`)
  for (const h of c.hits) console.log(fmtRow(h))
}

console.log("")
console.log(hr)
console.log(`SOFT candidates (not interested / hostile / wrong-owner / etc., not yet DNC'd): ${soft.length}`)
console.log(hr)
for (const c of soft) {
  console.log(`\n● ${c.key}  name=${c.name || "—"}  junk=${c.anyJunk}`)
  for (const h of c.hits) console.log(fmtRow(h))
}

console.log("")
console.log(hr)
console.log(`Already is_dnc=true (no action): ${already.length}`)
console.log(hr)

const out = {
  generated_at: new Date().toISOString(),
  total_lead_rows: all.length,
  strong_candidates: strong.length,
  soft_candidates: soft.length,
  already_dnc_clusters: already.length,
  candidates: [...strong, ...soft].map((c) => ({
    bucket: c.hits.some((h) => h.bucket === "strong") ? "strong" : "soft",
    key: c.key,
    name: c.name,
    rules: [...new Set(c.hits.map((h) => h.rule))],
    rep_lead_id: c.hits[0].row.id,
    all_lead_ids: c.allInCluster.map((r) => r.id),
    snippets: c.hits.map((h) => ({
      lead_id: h.row.id,
      lead_type: h.row.lead_type,
      status: h.row.status,
      field: h.field,
      rule: h.rule,
      text: h.snippet,
      created_at: h.row.created_at,
    })),
  })),
}
writeFileSync(new URL("./audit-dnc-wide.json", import.meta.url), JSON.stringify(out, null, 2))
console.log(`\nWrote scripts/audit-dnc-wide.json`)
