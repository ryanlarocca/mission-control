#!/usr/bin/env node
// Second wider pass — catches polite-decline AI summaries that the first
// audit missed. Only surfaces clusters NOT already flagged by audit-dnc-wide
// so we don't re-litigate the same 15.

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

// Keys already surfaced in the first wide audit — skip these.
const firstPass = JSON.parse(readFileSync(new URL("./audit-dnc-wide.json", import.meta.url), "utf8"))
const knownKeys = new Set(firstPass.candidates.map((c) => c.key))

// Stronger DNC tells.
const STRONG_RULES = [
  { name: "absolute-never-sell",    test: (n) => /\b(will\s+(?:absolutely\s+)?never\s+sell|never\s+(?:going\s+to|gonna)\s+sell|no\s+intention\s+of\s+ever\s+(?:sell|moving)|no\s+plans?\s+to\s+ever\s+sell|absolutely\s+(?:not|won['’]?t)\s+sell)/i.test(n) },
  { name: "AI flagged opt-out / no-follow-up", test: (n) => /\b(explicit\s+opt[- ]?out|no\s+follow[- ]?up\s+warranted|do\s+not\s+follow\s+up|will\s+not\s+follow\s+up|no\s+further\s+(?:action|contact)|hostile\s+opt[- ]?out)\b/i.test(n) },
  { name: "harassment / hostile",   test: (n) => /\b(harass(?:ing|ment)|leave\s+(?:me|us)\s+alone|stop\s+bothering|threatened?|reported?\s+(?:to|you)|legal\s+action|cease\s+and\s+desist)\b/i.test(n) },
]

// Hedged decline = nurture candidate.
const SOFT_RULES = [
  { name: "no plans to sell/move",  test: (n) => /\bno\s+plans?\s+(?:to|of)\s+(?:sell|move|sale|relocat)/i.test(n) },
  { name: "happy here / staying",   test: (n) => /\b(happy\s+(?:here|in\s+(?:our|my|the)\s+(?:home|house))|going\s+to\s+stay|we['’]?re\s+staying|plan\s+to\s+stay|intend\s+to\s+stay|love\s+(?:our|my|this)\s+(?:home|house|place))/i.test(n) },
  { name: "decided to keep / not sell", test: (n) => /\b(decided\s+(?:not\s+to\s+sell|to\s+keep)|chose\s+(?:not\s+to\s+sell|to\s+keep)|won['’]?t\s+(?:be\s+)?(?:consider(?:ing)?|selling)|wouldn['’]?t\s+(?:be\s+)?(?:consider(?:ing)?|selling))/i.test(n) },
  { name: "polite decline phrasing", test: (n) => /\b((?:thanks?|thank\s+you)\s+(?:but|for\s+(?:reaching|the\s+(?:offer|letter|interest)))[^.]{0,80}(?:not\s+(?:interested|selling)|pass|decline)|appreciate\s+(?:the\s+offer|reaching\s+out)[^.]{0,40}(?:but|however)[^.]{0,40}(?:not|won['’]?t|decline))/i.test(n) },
  { name: "passing / we'll pass",    test: (n) => /\b(we['’]?ll\s+pass|going\s+to\s+pass|gonna\s+pass|passing\s+on\s+(?:this|the\s+offer))/i.test(n) },
  { name: "long-time owner, not selling", test: (n) => /\b(long[- ]?time\s+owner|been\s+(?:here|in\s+(?:our|my|the)\s+(?:home|house))\s+(?:for\s+)?(?:a\s+long\s+time|many\s+years|\d+\s+years))[^.]{0,80}(?:not\s+(?:sell|interested|moving)|no\s+plans?|keeping)/i.test(n) },
  { name: "deceased owner / estate", test: (n) => /\b(owner\s+(?:passed\s+(?:away)?|is\s+deceased|has\s+died|recently\s+passed)|the\s+owner\s+passed|estate\s+only|in\s+probate)/i.test(n) },
  { name: "tenant not owner",       test: (n) => /\b(i['’]?m\s+(?:just\s+)?(?:a\s+|the\s+)?tenant|i['’]?m\s+(?:just\s+)?(?:a\s+|the\s+)?renter|(?:i['’]?m\s+)?not\s+the\s+owner|don['’]?t\s+own\s+(?:the|this))/i.test(n) },
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

const rowHits = []
for (const r of all) {
  const k = clusterKey(r)
  if (knownKeys.has(k)) continue
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

const clusters = new Map()
for (const h of rowHits) {
  const k = clusterKey(h.row)
  if (!clusters.has(k)) clusters.set(k, [])
  clusters.get(k).push(h)
}

const summary = []
for (const [key, hits] of clusters) {
  const allInCluster = all.filter((r) => clusterKey(r) === key)
  const anyDnc = allInCluster.some((r) => r.is_dnc === true)
  const anyJunk = allInCluster.some((r) => r.is_junk === true)
  const name = allInCluster.map((r) => r.name).find(Boolean) || null
  summary.push({ key, name, anyDnc, anyJunk, hits, allInCluster })
}

const strong  = summary.filter((c) => !c.anyDnc && c.hits.some((h) => h.bucket === "strong"))
const soft    = summary.filter((c) => !c.anyDnc && !c.hits.some((h) => h.bucket === "strong"))

const hr = "━".repeat(78)
const fmtRow = (h) => {
  const r = h.row
  const snip = (h.snippet || "").replace(/\s+/g, " ").slice(0, 200)
  return `    [${r.created_at.slice(0,10)}] ${r.lead_type.padEnd(9)} status=${r.status.padEnd(10)} field=${h.field}  rule="${h.rule}"
      "${snip}${(h.snippet || "").length > 200 ? "…" : ""}"`
}

console.log("")
console.log(hr)
console.log(`NEW STRONG candidates (not in first audit): ${strong.length}`)
console.log(hr)
for (const c of strong) {
  console.log(`\n● ${c.key}  name=${c.name || "—"}  junk=${c.anyJunk}`)
  for (const h of c.hits) console.log(fmtRow(h))
}

console.log("")
console.log(hr)
console.log(`NEW SOFT candidates (not in first audit): ${soft.length}`)
console.log(hr)
for (const c of soft) {
  console.log(`\n● ${c.key}  name=${c.name || "—"}  junk=${c.anyJunk}`)
  for (const h of c.hits) console.log(fmtRow(h))
}

writeFileSync(new URL("./audit-dnc-wider2.json", import.meta.url), JSON.stringify({
  generated_at: new Date().toISOString(),
  strong_count: strong.length,
  soft_count: soft.length,
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
    })),
  })),
}, null, 2))
console.log(`\nWrote scripts/audit-dnc-wider2.json`)
