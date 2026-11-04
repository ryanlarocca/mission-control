#!/usr/bin/env node
// The Pile — one search across Ryan's texts (2017→live), cell call log, contacts,
// CRMS names, and personal Gmail. Read-only. Runs on the Mac mini.
//
//   node scripts/pile/ask.mjs texts "<words>" [--with <name|phone>] [--since 2026-01-01] [--until ...] [--limit 50] [--mine|--theirs] [--no-groups]
//     (--with includes the group chats that person is in, labelled [Group: …]; --no-groups = private thread only)
//   node scripts/pile/ask.mjs calls [--with <name|phone>] [--since ...] [--limit 50]
//   node scripts/pile/ask.mjs who "<name|phone|email>"            → every identifier we know for a person
//   node scripts/pile/ask.mjs email "<words>" [--with <name|email>] [--since ...] [--limit 20]
//   node scripts/pile/ask.mjs person "<name|phone>" [--since ...]  → texts + calls + email with one person, newest first
//                                                                    (no saved match → unsaved threads that mention the name, newest first)
//   node scripts/pile/ask.mjs recent [--days 7] [--unsaved] [--each 2] → who texted Ryan lately, grouped by sender, self-intros pulled out
//   node scripts/pile/ask.mjs status
// Add --json for machine output.
import { ImapFlow } from "imapflow"
import { loadEnvFile, MC_ROOT } from "../mini-backup/lib.mjs"
import path from "node:path"

const env = { ...loadEnvFile(path.join(MC_ROOT, ".env.local")), ...process.env }
const SIDECAR = "http://localhost:5799"
const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = {}; const pos = []
for (let i = 1; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1"; flags[k] = v } else pos.push(a) }
const q = pos.join(" ").trim()
const JSON_OUT = flags.json === "1"
const limit = Number(flags.limit || (cmd === "email" ? 20 : 50))
const last10 = (s) => String(s || "").replace(/\D/g, "").slice(-10)
const fmt = (iso) => iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit" }) : ""
const sc = async (p, params = {}) => { const u = new URL(SIDECAR + p); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, v); const r = await fetch(u); if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`); return r.json() }

// ---- names: iPhone contacts (via sidecar) + CRMS relationships + leads (Supabase)
let _crms = null
async function crmsPeople() {
  if (_crms) return _crms
  const h = { apikey: env.LRG_SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.LRG_SUPABASE_SERVICE_KEY}` }
  const get = async (t) => { const r = await fetch(`${env.LRG_SUPABASE_URL}/rest/v1/${t}`, { headers: h }); return r.ok ? r.json() : [] }
  const rel = await get("relationships?select=name,phone,email,category&limit=5000")
  const leads = await get("leads?select=name,caller_phone,email,address&limit=5000")
  _crms = [
    ...rel.map((r) => ({ name: r.name, phones: [last10(r.phone)].filter((p) => p.length === 10), emails: [r.email].filter(Boolean).map((e) => e.toLowerCase()), src: `CRMS ${r.category || ""}`.trim() })),
    ...leads.filter((l) => l.name).map((l) => ({ name: l.name, phones: [last10(l.caller_phone)].filter((p) => p.length === 10), emails: [l.email].filter(Boolean).map((e) => e.toLowerCase()), src: `Lead${l.address ? " " + l.address : ""}` })),
  ]
  return _crms
}
async function resolve(query) {
  const digits = String(query || "").replace(/\D/g, "")
  const needle = String(query || "").toLowerCase()
  const fromContacts = await sc("/pile/identifiers", { q: query })
  const people = (await crmsPeople()).filter((p) => (digits.length >= 7 ? p.phones.includes(last10(digits)) : p.name.toLowerCase().includes(needle) || p.emails.some((e) => e.includes(needle))))
  const phones = [...new Set([...fromContacts.phones, ...people.flatMap((p) => p.phones), ...(digits.length >= 7 ? [last10(digits)] : [])])]
  const emails = [...new Set([...fromContacts.emails, ...people.flatMap((p) => p.emails), ...(needle.includes("@") ? [needle] : [])])]
  const names = [...new Set([...fromContacts.names, ...people.map((p) => `${p.name} (${p.src})`)])]
  return { phones, emails, names }
}
async function nameMap() { const m = new Map(); for (const p of await crmsPeople()) for (const ph of p.phones) if (!m.has(ph)) m.set(ph, p.name); return m }

// ---- Gmail (personal, IMAP)
async function searchEmail({ words, from, since, limit }) {
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: env.PILE_GMAIL_IMAP_USER, pass: env.PILE_GMAIL_IMAP_PASSWORD }, logger: false })
  await client.connect()
  try {
    await client.mailboxOpen("[Gmail]/All Mail", { readOnly: true })
    const crit = {}
    if (words) crit.text = words
    if (from) crit.or = [{ from }, { to: from }]
    if (since) crit.since = new Date(since)
    const uids = await client.search(crit, { uid: true })
    const pick = uids.slice(-limit).reverse()
    const out = []
    for await (const m of client.fetch(pick, { uid: true, envelope: true, bodyStructure: false, source: { maxLength: 4000 } }, { uid: true })) {
      const src = m.source ? m.source.toString("utf8") : ""
      const snippet = src.split(/\r?\n\r?\n/).slice(1).join(" ").replace(/<[^>]+>/g, " ").replace(/=\r?\n/g, "").replace(/\s+/g, " ").slice(0, 160)
      out.push({ at: m.envelope.date?.toISOString(), from: m.envelope.from?.map((a) => a.address).join(","), to: m.envelope.to?.map((a) => a.address).join(","), subject: m.envelope.subject, snippet, link: `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(m.envelope.messageId || "")}` })
    }
    return out
  } finally { await client.logout().catch(() => {}) }
}

// "Who texted me lately" is the first place to look when Ryan references
// someone's message (2026-11-03). An unsaved number never resolves by name, so
// the thread's own self-introduction ("this is Alex", "Jeff with Tier One") is
// the only handle we have for it.
const NOISE = /^(Liked|Loved|Laughed at|Emphasized|Disliked|Questioned|Reacted|Le gustó|Reaccionó|Se rió|Enfatizó)\b|Reply STOP|StopToEnd|unsubscribe|opt ?out|checked in at|your place on the/i
const INTRO = /\b(?:this is|it'?s|my name is|i'?m)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)(?: (?:with|from|at|@) ([A-Z][\w&' .-]{2,40}?))?(?=[,.!\s]|$)|^(?:hey|hi|hello)[^,.]*,?\s*([A-Z][a-z]+) (?:here|with ([A-Z][\w&' .-]{2,40}?))\b/
function intro(text) { const m = INTRO.exec(String(text || "")); if (!m) return null; const name = m[1] || m[3]; const org = m[2] || m[4]; return org ? `${name} (${org.trim()})` : name }
const clean = (t) => String(t).replace(/\s+/g, " ")

function printTexts(rows, names) { for (const r of rows) console.log(`${fmt(r.at).padEnd(22)} ${(r.group && r.from_me ? "me" : r.name || names.get(last10(r.number)) || r.number || "?").slice(0, 22).padEnd(22)} ${r.from_me ? "→" : "←"} ${r.group ? `[${r.group.label.slice(0, 40)}] ` : ""}${String(r.text).replace(/\s+/g, " ").slice(0, 110)}`) }
// A person with two numbers in the same group chat returns that chat twice — keep one copy.
const dedupeTexts = (rows) => { const seen = new Set(); return rows.filter((r) => { const k = `${r.at}|${r.group?.chat || ""}|${r.text}`; if (seen.has(k)) return false; seen.add(k); return true }) }
const groupsParam = () => (flags["no-groups"] ? "0" : "")
function printCalls(rows, names) { for (const r of rows) console.log(`${fmt(r.at).padEnd(22)} ${(r.name || names.get(last10(r.number)) || r.number || "?").slice(0, 22).padEnd(22)} ${r.direction === "outgoing" ? "→" : r.missed ? "✗" : "←"} ${r.type} ${r.seconds ? Math.round(r.seconds / 60) + "m" + (r.seconds % 60) + "s" : r.missed ? "missed" : "no answer"}`) }
function printEmail(rows) { for (const r of rows) console.log(`${fmt(r.at).padEnd(22)} ${String(r.from || "").slice(0, 28).padEnd(28)} ${String(r.subject || "").slice(0, 60)}\n${"".padEnd(23)}${r.snippet}\n${"".padEnd(23)}${r.link}`) }

async function main() {
  const names = await nameMap().catch(() => new Map())
  if (cmd === "status") { const s = await sc("/pile/status"); console.log(JSON.stringify(s, null, 2)); return }
  if (cmd === "who") { const r = await resolve(q); console.log(JSON_OUT ? JSON.stringify(r) : `names: ${r.names.join("; ") || "—"}\nphones: ${r.phones.join(", ") || "—"}\nemails: ${r.emails.join(", ") || "—"}`); return }
  if (cmd === "texts") {
    const who = flags.with ? await resolve(flags.with) : null
    let rows = []
    if (who && who.phones.length) for (const p of who.phones) rows.push(...await sc("/pile/texts", { q, phone: p, since: flags.since, until: flags.until, limit, from_me: flags.mine ? "1" : flags.theirs ? "0" : "", groups: groupsParam() }))
    else rows = await sc("/pile/texts", { q, since: flags.since, until: flags.until, limit, from_me: flags.mine ? "1" : flags.theirs ? "0" : "", groups: groupsParam() })
    rows = dedupeTexts(rows); rows.sort((a, b) => (a.at < b.at ? 1 : -1)); rows = rows.slice(0, limit)
    if (JSON_OUT) return console.log(JSON.stringify(rows))
    console.log(`${rows.length} texts${q ? ` matching "${q}"` : ""}${who ? ` with ${who.names[0] || flags.with}` : ""}`); printTexts(rows, names); return
  }
  if (cmd === "calls") {
    const who = flags.with ? await resolve(flags.with) : null
    let rows = []
    if (who && who.phones.length) for (const p of who.phones) rows.push(...await sc("/pile/calls", { phone: p, since: flags.since, until: flags.until, limit }))
    else rows = await sc("/pile/calls", { q, since: flags.since, until: flags.until, limit })
    rows.sort((a, b) => (a.at < b.at ? 1 : -1)); rows = rows.slice(0, limit)
    if (JSON_OUT) return console.log(JSON.stringify(rows))
    console.log(`${rows.length} calls`); printCalls(rows, names); return
  }
  if (cmd === "email") {
    const who = flags.with ? await resolve(flags.with) : null
    const rows = await searchEmail({ words: q || undefined, from: who?.emails[0] || (flags.with?.includes("@") ? flags.with : undefined), since: flags.since, limit })
    if (JSON_OUT) return console.log(JSON.stringify(rows))
    console.log(`${rows.length} emails${q ? ` matching "${q}"` : ""}`); printEmail(rows); return
  }
  if (cmd === "person") {
    const who = await resolve(q)
    console.log(`== ${q} → ${who.names.join("; ") || "no name match"} | phones ${who.phones.join(", ") || "—"} | emails ${who.emails.join(", ") || "—"}`)
    let texts = []; for (const p of who.phones) texts.push(...await sc("/pile/texts", { phone: p, since: flags.since, limit, groups: groupsParam() }))
    texts = dedupeTexts(texts)
    if (!texts.length && /[a-z]/i.test(q) && !/\d{7}/.test(q)) {
      // Nobody saved under that name has texted — they may be unsaved and known
      // only from their own "this is <name>" (the Alex-the-wholesaler case).
      const first = q.split(/\s+/)[0]
      const word = new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
      const hits = (await sc("/pile/texts", { q: first, from_me: "0", groups: "0", limit: 300 })).filter((r) => r.text && word.test(r.text) && !who.phones.includes(last10(r.number)))
      const by = new Map(); for (const r of hits) { const k = last10(r.number) || r.number; if (!by.has(k) || by.get(k).at < r.at) by.set(k, r) }
      const cands = [...by.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 8)
      if (cands.length) {
        console.log(`\n-- no texts from a saved "${q}"; ${cands.length} other thread(s) mention the name (newest first):`)
        for (const c of cands) console.log(`   ${fmt(c.at).padEnd(22)} ${String(c.name || names.get(last10(c.number)) || c.number).slice(0, 22).padEnd(22)} ${intro(c.text) ? `[${intro(c.text)}] ` : ""}${clean(c.text).slice(0, 100)}`)
        const top = last10(cands[0].number) || cands[0].number
        texts = dedupeTexts(await sc("/pile/texts", { phone: top, since: flags.since, limit, groups: groupsParam() }))
        who.phones.push(top)
        console.log(`-- showing the newest of those threads (${top}); run person <number> for another`)
      }
    }
    const calls = []; for (const p of who.phones) calls.push(...await sc("/pile/calls", { phone: p, since: flags.since, limit }))
    const emails = who.emails.length ? await searchEmail({ from: who.emails[0], since: flags.since, limit: Math.min(limit, 20) }).catch((e) => { console.error("email:", e.message); return [] }) : []
    texts.sort((a, b) => (a.at < b.at ? 1 : -1)); calls.sort((a, b) => (a.at < b.at ? 1 : -1))
    if (JSON_OUT) return console.log(JSON.stringify({ who, texts, calls, emails }))
    const shown = texts.slice(0, limit), inGroups = shown.filter((t) => t.group)
    console.log(`\n-- ${shown.length} texts (newest first, limit ${limit}): ${shown.length - inGroups.length} private, ${inGroups.length} in ${new Set(inGroups.map((t) => t.group.chat)).size} group chats`); printTexts(shown, names)
    console.log(`\n-- ${calls.length} calls`); printCalls(calls.slice(0, limit), names)
    console.log(`\n-- ${emails.length} emails`); printEmail(emails); return
  }
  if (cmd === "recent") {
    const days = Number(flags.days || 7)
    const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10)
    const rows = (await sc("/pile/texts", { since, from_me: "0", groups: "0", limit: Number(flags.limit || 2000) })).filter((r) => r.text && !NOISE.test(r.text))
    const by = new Map()
    for (const r of rows) { const k = last10(r.number) || r.number; const g = by.get(k) || { number: k, name: r.name || names.get(k) || null, msgs: [] }; g.msgs.push(r); by.set(k, g) }
    let groups = [...by.values()].map((g) => { g.msgs.sort((a, b) => (a.at < b.at ? 1 : -1)); g.newest = g.msgs[0].at; return g }).sort((a, b) => (a.newest < b.newest ? 1 : -1))
    if (flags.unsaved) groups = groups.filter((g) => !g.name)
    for (const g of groups) {
      g.intro = g.msgs.map((m) => intro(m.text)).find(Boolean) || null
      if (!g.name) {
        // Look back to the start of the thread: the self-introduction is usually the first text.
        const thread = (await sc("/pile/texts", { phone: g.number, from_me: "0", groups: "0", limit: 500 })).filter((r) => r.text).sort((a, b) => (a.at < b.at ? -1 : 1))
        g.intro = thread.slice(0, 5).map((m) => intro(m.text)).find(Boolean) || g.intro
        g.first = thread[0]?.at || null
      }
    }
    if (JSON_OUT) return console.log(JSON.stringify(groups))
    console.log(`${groups.length} ${flags.unsaved ? "unsaved numbers" : "people"} texted you in the last ${days} days (inbound, private threads, tapbacks/marketing skipped)`)
    for (const g of groups) {
      const label = g.name || `${g.number} (unsaved${g.intro ? ` — "${g.intro}"` : ""}${g.first ? `, first text ${fmt(g.first).split(",")[0]}` : ""})`
      console.log(`\n${label} — ${g.msgs.length} text${g.msgs.length === 1 ? "" : "s"}, last ${fmt(g.newest)}`)
      for (const m of g.msgs.slice(0, Number(flags.each || 2))) console.log(`   ${fmt(m.at).padEnd(22)} ${clean(m.text).slice(0, 140)}`)
    }
    return
  }
  console.log("usage: ask.mjs texts|calls|who|email|person|recent|status …  (see header)")
}
main().catch((e) => { console.error(e.message); process.exit(1) })
