#!/usr/bin/env node
// Build the Reply Planner eval set (Phase 0 of BRIEF_REPLY_PLANNER_2026-09-24).
// Pulls 20 real moments — the inbound message(s) + Ryan's actual reply — and
// writes briefs/tests/reply-eval-set.json plus a grading sheet
// briefs/tests/REPLY_EVAL_GRADING.md for Ryan to mark up.
//
// Usage: node scripts/reply-eval-build.mjs
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

// Lead items: keyed by the cluster (phone or email) + the date of the inbound
// message that defines the moment. The thread is every row in the cluster up
// to and including Ryan's first reply after that inbound.
const LEAD_ITEMS = [
  { moment: "soft_no",            key: "vslater99@gmail.com",  inboundDate: "2026-09-24", note: "Reference reply below is the one agreed 2026-09-24, not what was sent (nothing was sent)." ,
    reference: "Got it, Virginia, and thanks for letting me know, I appreciate the reply. No problem at all. If anything changes with the rental down the road, a tenant moving out or just a change in plans, I'm a quick email away. I'll check in once in a while to stay in touch.\n\nRyan" },
  { moment: "soft_no",            name: "Dennis Connally",     inboundDate: "2026-05-11" },
  { moment: "soft_no",            name: "Terry Chandler",      inboundDate: "2026-05-12" },
  { moment: "soft_no",            key: "+18185363213",         inboundDate: "2026-05-30", note: "Not selling, but curious about value. Two-step exchange." },
  { moment: "offer_requested",    name: "Mehran Beheshti",     inboundDate: "2026-05-19" },
  { moment: "offer_requested",    name: "Grace Chang",         inboundDate: "2026-05-18" },
  { moment: "info_provided",      name: "Yanhui Liu",          inboundDate: "2026-05-30" },
  { moment: "info_provided",      key: "+14084311054",         inboundDate: "2026-05-28", note: "'3/2 and 2/1' → Ryan floats ~$1M and asks for a call." },
  { moment: "price_pushback",     name: "Greg Hammer",         inboundDate: "2026-05-17" },
  { moment: "price_pushback",     name: "Augustine",           inboundDate: "2026-07-20" },
  { moment: "price_pushback",     name: "Jesus",               inboundDate: "2026-06-05" },
  { moment: "price_pushback",     name: "Mehran Beheshti",     inboundDate: "2026-05-20", note: "Seller quotes 1.5–1.9M comps after remodel." },
  { moment: "hard_no_optout",     key: "+14084311054",         inboundDate: "2026-05-28", match: "Good luck", note: "'Good luck with your search' after the ~$1M float." },
  { moment: "question",           name: "Chris Shoemaker",     inboundDate: "2026-05-13", note: "Agent asks whether the letter is a form letter." },
  { moment: "question",           name: "Shu Liu",             inboundDate: "2026-06-03", note: "'Who is that?'" },
  { moment: "invitation_to_talk", name: "Steve Beloski",       inboundDate: "2026-05-28" },
  { moment: "info_provided",      name: "Tony",                inboundDate: "2026-05-17", note: "Accepted someone else's as-is offer." },
  { moment: "reply_to_them",      name: "Gregory Marshall",    inboundDate: "2026-09-03", note: "Long-running contact; 'under contract to sell'." },
]

// Relationships items: touches where Ryan edited the AI draft before sending.
// Reference = what Ryan sent. The generated draft is kept so the diff is visible.
const REL_ITEMS = [
  { moment: "re_engagement", name: "Paige Morehead", date: "2026-09-23" },
  { moment: "re_engagement", name: "Marjan Mansouri", date: "2026-09-02" },
  { moment: "re_engagement", name: "Alfredo Barajas", date: "2026-09-23" },
  { moment: "re_engagement", name: "Tyler Willz", date: "2026-08-06" },
]

async function allLeads() {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const r = await sb.from("leads").select("id,created_at,caller_phone,email,name,lead_type,twilio_number,message,status,temperature,source,property_address,ai_summary,notes,property_details").order("created_at", { ascending: true }).range(from, from + 999)
    if (r.error) throw r.error
    rows.push(...r.data)
    if (r.data.length < 1000) break
  }
  return rows
}
const ckey = r => r.caller_phone || (r.email || "").toLowerCase() || r.id
const dir = r => (r.twilio_number ? "them" : (r.lead_type || "").startsWith("drip_") ? "ryan(drip)" : "ryan")
const clean = s => (s || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim()

async function buildLeadItem(spec, rows) {
  let cluster
  if (spec.key) cluster = rows.filter(r => ckey(r) === spec.key.toLowerCase() || ckey(r) === spec.key)
  else {
    const named = rows.filter(r => (r.name || "").toLowerCase() === spec.name.toLowerCase())
    const keys = new Set(named.map(ckey))
    cluster = rows.filter(r => keys.has(ckey(r)))
  }
  cluster.sort((a, b) => a.created_at.localeCompare(b.created_at))
  const idx = cluster.findIndex(r => r.twilio_number && r.created_at.startsWith(spec.inboundDate) && (!spec.match || (r.message || "").includes(spec.match)))
  if (idx < 0) throw new Error(`no inbound for ${spec.name || spec.key} on ${spec.inboundDate}`)
  const inbound = cluster[idx]
  const replyIdx = cluster.findIndex((r, i) => i > idx && !r.twilio_number && ["email", "sms"].includes(r.lead_type) && (r.message || "").trim())
  const reply = replyIdx >= 0 ? cluster[replyIdx] : null
  const thread = cluster.slice(0, replyIdx >= 0 ? replyIdx : idx + 1)
    .filter(r => (r.message || "").trim())
    .map(r => ({ at: r.created_at, from: dir(r), channel: r.lead_type, text: clean(r.message).slice(0, 2500) }))
  const anchor = cluster.find(r => r.property_address) || inbound
  return {
    id: `${spec.moment}:${(spec.name || spec.key).replace(/\s+/g, "_")}:${spec.inboundDate}`,
    surface: "leads", moment: spec.moment, channel: inbound.lead_type,
    contact: { name: inbound.name || anchor.name || null, key: ckey(inbound), property_address: anchor.property_address || null, source: anchor.source || null, temperature: inbound.temperature || null },
    note: spec.note || null,
    thread,
    inbound: { at: inbound.created_at, text: clean(inbound.message) },
    reference_reply: spec.reference || (reply ? clean(reply.message) : null),
    reference_source: spec.reference ? "agreed_2026-09-24" : reply ? "ryan_sent" : null,
    grade: null, why: null,
  }
}

async function buildRelItem(spec) {
  const rel = await sb.from("relationships").select("id,name,category,tier,notes,last_contacted_at").ilike("name", `%${spec.name}%`).limit(1)
  if (rel.error || !rel.data.length) throw new Error(`relationship not found: ${spec.name}`)
  const r = rel.data[0]
  const t = await sb.from("relationship_touches").select("*").eq("relationship_id", r.id).eq("action", "sent").gte("occurred_at", spec.date).lt("occurred_at", spec.date + "T23:59:59").order("occurred_at").limit(1)
  if (t.error || !t.data.length) throw new Error(`touch not found: ${spec.name} ${spec.date}`)
  const touch = t.data[0]
  return {
    id: `${spec.moment}:${spec.name.replace(/\s+/g, "_")}:${spec.date}`,
    surface: "relationships", moment: spec.moment, channel: touch.modality,
    contact: { name: r.name, category: r.category, tier: r.tier, notes: clean(r.notes).slice(0, 1500) },
    note: "Ryan edited the AI draft before sending. Reference = what he sent.",
    thread: [],
    generated_draft: clean(touch.generated_message),
    reference_reply: clean(touch.message),
    reference_source: "ryan_sent_edited",
    replied: !!touch.replied_at,
    grade: null, why: null,
  }
}

const rows = await allLeads()
const items = []
for (const s of LEAD_ITEMS) items.push(await buildLeadItem(s, rows))
for (const s of REL_ITEMS) items.push(await buildRelItem(s))

const set = { built_at: new Date().toISOString(), brief: "briefs/BRIEF_REPLY_PLANNER_2026-09-24.md", items }
writeFileSync(new URL("../briefs/tests/reply-eval-set.json", import.meta.url), JSON.stringify(set, null, 2))

// Grading sheet
let md = `# Reply eval set — grading sheet\n\nBuilt ${set.built_at.slice(0, 10)} from real CRMS moments. For each item, read the thread, then the\n**reference reply** (what Ryan actually sent, or the reply agreed on 2026-09-24).\n\nGrade by item number, in chat or voice:\n- **keep** — I'd send that again as-is.\n- **fix: <one sentence why>** — the reference is not what I'd send now; say what's off.\n- **skip** — bad example, drop it.\n\nThe grades and whys become the first entries in \`REPLY_PLAYBOOK.md\` and the\nbaseline every prompt change is measured against.\n\n`
items.forEach((it, i) => {
  md += `---\n\n## ${i + 1}. ${it.contact.name || it.contact.key} — \`${it.moment}\` (${it.surface}, ${it.channel})\n\n`
  if (it.contact.property_address) md += `Property: ${it.contact.property_address}  \n`
  if (it.contact.category) md += `Category: ${it.contact.category} / tier ${it.contact.tier}  \n`
  if (it.note) md += `Note: ${it.note}  \n`
  md += `\n`
  if (it.thread.length) {
    md += `**Thread**\n\n`
    for (const m of it.thread) md += `> **${m.from}** · ${m.at.slice(0, 10)} · ${m.channel}\n> ${m.text.replace(/\n/g, "\n> ")}\n>\n`
    md += `\n`
  }
  if (it.generated_draft) md += `**AI draft (what the system offered)**\n\n> ${it.generated_draft.replace(/\n/g, "\n> ")}\n\n`
  if (it.contact.notes) md += `**Notes on the contact**\n\n> ${it.contact.notes.replace(/\n/g, "\n> ")}\n\n`
  md += `**Reference reply** (${it.reference_source})\n\n> ${(it.reference_reply || "(none)").replace(/\n/g, "\n> ")}\n\n**Grade:** ☐ keep ☐ fix ☐ skip  \n**Why:** \n\n`
})
writeFileSync(new URL("../briefs/tests/REPLY_EVAL_GRADING.md", import.meta.url), md)
console.log(`wrote ${items.length} items`)
for (const it of items) console.log(` ${it.id}  thread=${it.thread.length} ref=${it.reference_reply ? "yes" : "NO"}`)
