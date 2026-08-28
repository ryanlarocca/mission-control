#!/usr/bin/env node
// Skip-trace phone-only direct-mail leads via FastPeopleSearch.
//
// Ryan's manual loop was: paste the caller's phone into Google → FPS is the
// first hit → read the address. This scripts exactly that, no more: one
// headed real-Chrome window (plain HTTP gets a Cloudflare 403; headed Chrome
// loads fine), sequential, human-paced. If a challenge/CAPTCHA appears the
// script WAITS for a human to click it — it never tries to defeat one.
//
// What it writes (per phone cluster, every row on the cluster):
//   • name  — only when every row's name is empty / a phone placeholder
//   • notes — appends a dated "[Skip trace … UNVERIFIED]" block listing EVERY
//             address found (Ryan confirms which one the letter reached on the
//             next call) + life-situation flags. Never overwrites his text.
//
// Modes:
//   --backfill            every live direct-mail cluster with a phone (skips
//                         clusters already carrying a skip-trace block)
//   --since <hours>       only clusters whose first row is newer than N hours
//                         AND still have no property_address (intake mode)
//   --phone +1408…        one number
//   --force               re-trace even if a block already exists
//   --dry-run             look up + print, write nothing
//
// Project memo: ~/Projects/PROJECTS/lead-skip-trace/PROJECT_MEMO.md
import fs from "node:fs"
import path from "node:path"
import { chromium } from "playwright"

const envPath = [
  "/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control/.env.local",
  path.join(process.cwd(), ".env.local"),
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

const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
const DRY = flag("--dry-run"), FORCE = flag("--force")
const SINCE_H = opt("--since") ? Number(opt("--since")) : null
const ONE = opt("--phone")
if (!flag("--backfill") && !SINCE_H && !ONE) {
  console.error("usage: skip-trace-fps.mjs --backfill | --since <hours> | --phone <E164> [--force] [--dry-run]")
  process.exit(1)
}

const TODAY = new Date().toLocaleDateString("en-CA")
const MARK = "[Skip trace"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (lo, hi) => lo + Math.random() * (hi - lo)
const isPlaceholderName = (n) => {
  if (!n || !n.trim()) return true
  const d = n.replace(/\D/g, "")
  return /^[\d\s().+-]+$/.test(n.trim()) && d.length >= 10 && d.length <= 11
}
const isAnon = (p) => !p || /555\d{4}$/.test(p) || /anonym|restrict|unavail|private|unknown/i.test(p) || p.replace(/\D/g, "").length < 10
const fmtPhone = (e164) => { const d = e164.replace(/\D/g, "").slice(-10); return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` }

// ---------- leads ----------
async function fetchAllLeads() {
  const rows = []
  for (let o = 0; ; o += 1000) {
    const r = await fetch(`${SB}/rest/v1/leads?select=id,caller_phone,name,email,notes,property_address,source,source_type,status,is_dnc,is_junk,created_at&order=created_at.asc`, { headers: { ...H, Range: `${o}-${o + 999}` } })
    const j = await r.json()
    rows.push(...j)
    if (j.length < 1000) break
  }
  return rows
}
function selectClusters(rows) {
  const by = new Map()
  for (const r of rows) {
    if (r.source_type !== "direct_mail" || isAnon(r.caller_phone)) continue
    if (!by.has(r.caller_phone)) by.set(r.caller_phone, [])
    by.get(r.caller_phone).push(r)
  }
  const out = []
  for (const [phone, ls] of by) {
    if (ONE && phone !== ONE) continue
    if (ls.some((l) => l.is_dnc || l.is_junk || l.status === "dead")) continue
    if (!FORCE && ls.some((l) => (l.notes || "").includes(MARK))) continue
    if (SINCE_H) {
      const first = ls.map((l) => l.created_at).sort()[0]
      if (Date.now() - new Date(first).getTime() > SINCE_H * 3600_000) continue
      if (ls.some((l) => l.property_address)) continue
    }
    out.push({ phone, rows: ls })
  }
  return out
}

// ---------- scrape ----------
async function waitForHumanIfChallenged(page) {
  for (let i = 0; i < 120; i++) { // up to 10 min — Ryan is usually on calls
    const title = await page.title().catch(() => "")
    const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "")
    // Cloudflare Turnstile ("Verify you are human" checkbox) lives in an
    // iframe — invisible to innerText, so check for the frame itself.
    const turnstile = await page.evaluate(() => !!document.querySelector("iframe[src*='challenges.cloudflare.com']")).catch(() => false)
    if (turnstile) {
      if (i === 0) console.log("  ⚠ Cloudflare 'Verify you are human' checkbox — needs one human click in the Chrome window (waiting up to 10 min)…")
      await sleep(5000); continue
    }
    // Strict: Cloudflare's interstitial title / opening text only. The word
    // "challenge" alone appears in normal FPS page copy.
    const challenged = /security challenge|attention required|access denied/i.test(title) || /verify you are human|checking your browser/i.test(body.slice(0, 300))
    if (!challenged) return true
    if (i === 0) console.log(`  ⚠ challenge page — waiting for a human to clear it (10 min max)… [${title}]`)
    await sleep(5000)
  }
  return false
}
function parseCard(text) {
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean)
  const name = lines[0] || null
  const meta = lines.find((l) => /^Age \d+|^Deceased/.test(l)) || ""
  const dec = meta.match(/Deceased \((\d{4}) - (\d{4})\)/)
  const age = meta.match(/Age (\d+)/)
  const rel = lines.find((l) => /^Relatives:/.test(l))
  return {
    name,
    age: age ? Number(age[1]) : null,
    deceased: dec ? { born: Number(dec[1]), died: Number(dec[2]) } : null,
    city: (meta.split("•")[1] || "").trim() || null,
    relatives: rel ? rel.replace(/^Relatives:\s*/, "").split("•").map((s) => s.trim()).filter(Boolean) : [],
  }
}
async function scrapePhone(page, phone) {
  const url = `https://www.fastpeoplesearch.com/${fmtPhone(phone)}`
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await sleep(jitter(3500, 6000))
  // FPS shows its own "Just a moment… Loading Search Results" splash that
  // resolves on its own — wait for real content (cards or the no-results
  // notice) up to 25 s before deciding anything.
  await page.waitForFunction(() => /No results found for phone/i.test(document.body.innerText) || document.querySelector("a[href*='_id_']"), null, { timeout: 25_000 }).catch(() => {})
  if (!(await waitForHumanIfChallenged(page))) return { status: "challenge", persons: [] }
  await page.waitForFunction(() => /No results found for phone/i.test(document.body.innerText) || document.querySelector("a[href*='_id_']"), null, { timeout: 25_000 }).catch(() => {})
  const body = await page.evaluate(() => document.body.innerText)
  if (/No results found for phone/i.test(body)) return { status: "no_record", persons: [] }
  const cards = await page.evaluate(() => {
    const seen = new Set(); const out = []
    for (const a of document.querySelectorAll("a[href*='_id_']")) {
      const card = a.closest(".card, [class*=card]"); if (!card || seen.has(a.href)) continue
      seen.add(a.href); out.push({ link: a.href, text: card.innerText })
    }
    return out
  })
  // Dedupe (nested card elements yield the same person several times) and
  // keep only the first 4 — FPS lists the number's actual holders first,
  // then a long tail of relatives.
  const seenKey = new Set()
  const persons = cards.map((c) => ({ link: c.link, ...parseCard(c.text) }))
    .filter((p) => p.name && !seenKey.has(`${p.name}|${p.age}|${p.deceased?.died}`) && seenKey.add(`${p.name}|${p.age}|${p.deceased?.died}`))
    .slice(0, 4)
  if (!persons.length) {
    const t = await page.title().catch(() => "")
    if (process.env.ST_DEBUG) { console.log(`\n   [debug] no cards — title="${t}" body="${body.slice(0, 160).replace(/\n/g, " ")}"`); await page.screenshot({ path: "/tmp/skip-trace-last.png" }).catch(() => {}) }
    return { status: "no_cards", persons: [] }
  }
  // Visit living persons' pages (max 3) for addresses.
  const living = persons.filter((p) => !p.deceased).slice(0, 3)
  for (const p of living) {
    await sleep(jitter(4000, 8000))
    await page.goto(p.link, { waitUntil: "domcontentloaded", timeout: 45_000 })
    await sleep(jitter(3000, 5000))
    // Same splash as the results page — wait for the profile sections (or a
    // real challenge title) before reading.
    await page.waitForFunction(() => document.getElementById("current_address_section") || document.getElementById("previous-addresses") || /security challenge|attention required/i.test(document.title), null, { timeout: 25_000 }).catch(() => {})
    if (!(await waitForHumanIfChallenged(page))) break
    const d = await page.evaluate(() => {
      const t = (id) => document.getElementById(id)?.innerText || ""
      return { cur: t("current-addresses-property"), prev: t("previous-addresses"), body: document.body.innerText.slice(0, 3000) }
    })
    if (process.env.ST_DEBUG) console.log(`\n   [debug] ${p.name}: cur=${d.cur.length}ch prev=${d.prev.length}ch title=${await page.title()}`)
    const since = d.body.match(/Current Address \(Since ([A-Za-z]+ (\d{4}))\)/)
    const born = d.body.match(/Born ([A-Za-z]+ \d{4})/)
    const curLines = d.cur.split("\n").map((s) => s.trim()).filter(Boolean)
    const addrIdx = curLines.findIndex((l) => /^\d+ .+/.test(l) && !/^Bedrooms|^Bathrooms/.test(l))
    const kv = {}
    for (let i = 0; i < curLines.length - 1; i++) if (/^(Bedrooms|Bathrooms|Square Feet|Year Built|Estimated Value|Estimated Equity|Occupancy Type|Ownership Type|Land Use|Lot SqFt\.?)$/.test(curLines[i])) kv[curLines[i]] = curLines[i + 1]
    p.current = addrIdx >= 0 ? { address: `${curLines[addrIdx]}, ${curLines[addrIdx + 1] || ""}`.trim(), since: since ? since[1] : null, sinceYear: since ? Number(since[2]) : null, ...kv } : null
    p.born = born ? born[1] : null
    const prev = [], pl = d.prev.split("\n").map((s) => s.trim()).filter(Boolean)
    for (let i = 0; i < pl.length; i++) if (/^\d+ .+/.test(pl[i]) && pl[i + 1] && /[A-Z]{2} \d{5}/.test(pl[i + 1])) {
      const rec = (pl.slice(i, i + 5).find((x) => /^Recorded /.test(x)) || "").replace("Recorded ", "")
      prev.push({ address: `${pl[i]}, ${pl[i + 1]}`, recorded: rec || null })
    }
    p.previous = prev
  }
  return { status: "ok", persons }
}

// ---------- flags + note ----------
function flagsFor(persons) {
  const f = []
  if (persons.some((p) => p.deceased)) f.push("DECEASED CO-OWNER/SPOUSE on this number")
  for (const p of persons) if (p.age >= 75 && p.current?.sinceYear && new Date().getFullYear() - p.current.sinceYear >= 20) f.push(`${p.name} is ${p.age}, at ${p.current.address.split(",")[0]} since ${p.current.since} (${new Date().getFullYear() - p.current.sinceYear} yrs)`)
  const allAddr = persons.flatMap((p) => [p.current?.address, ...(p.previous || []).map((a) => a.address)]).filter(Boolean)
  const nums = allAddr.map((a) => ({ a, n: Number(a.match(/^(\d+)/)?.[1]), st: a.replace(/^\d+\s+/, "").split(",")[0] }))
  const adj = nums.filter((x) => nums.some((y) => y !== x && y.st === x.st && Math.abs(y.n - x.n) <= 4))
  if (adj.length) f.push(`adjacent street numbers (likely the multifamily): ${[...new Set(adj.map((x) => x.a.split(",")[0]))].join(" / ")}`)
  for (const p of persons) if (p.current && p.current["Occupancy Type"] && !/owner/i.test(p.current["Occupancy Type"])) f.push(`${p.current.address.split(",")[0]} is ${p.current["Occupancy Type"]}`)
  return f
}
function buildNote(res) {
  const L = [`[Skip trace ${TODAY} — fastpeoplesearch.com, UNVERIFIED — confirm which property the letter reached]`]
  if (res.status !== "ok") { L.push(`No record found (${res.status}).`); return L.join("\n") }
  const flags = flagsFor(res.persons)
  if (flags.length) L.push(`⚑ LIFE-SITUATION WATCH: ${flags.join(" · ")}`)
  for (const p of res.persons) {
    L.push(`• ${p.name}${p.deceased ? ` — DECEASED (${p.deceased.born}–${p.deceased.died})` : p.age ? `, age ${p.age}${p.born ? ` (b. ${p.born})` : ""}` : ""}${p.city ? ` — ${p.city}` : ""}`)
    if (p.current) L.push(`   Current: ${p.current.address}${p.current.since ? ` (since ${p.current.since})` : ""}${p.current["Land Use"] ? ` — ${p.current["Land Use"]}` : ""}${p.current["Occupancy Type"] ? `, ${p.current["Occupancy Type"]}` : ""}${p.current["Estimated Value"] ? `, est ${p.current["Estimated Value"]}` : ""}${p.current["Year Built"] ? `, built ${p.current["Year Built"]}` : ""}`)
    for (const a of p.previous || []) L.push(`   Prev: ${a.address}${a.recorded ? ` (rec. ${a.recorded})` : ""}`)
    if (p.relatives?.length) L.push(`   Relatives: ${p.relatives.join(", ")}`)
  }
  return L.join("\n")
}

// ---------- write ----------
async function writeCluster(cluster, res) {
  const note = buildNote(res)
  const living = res.persons.find((p) => !p.deceased && p.name)
  const setName = living && cluster.rows.every((r) => isPlaceholderName(r.name)) ? living.name : null
  if (DRY) { console.log(note + (setName ? `\n   → name: ${setName}` : "")); return }
  for (const r of cluster.rows) {
    const patch = { notes: r.notes ? `${r.notes.trimEnd()}\n\n${note}` : note }
    if (setName) patch.name = setName
    const resp = await fetch(`${SB}/rest/v1/leads?id=eq.${r.id}`, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(patch) })
    if (!resp.ok) console.log(`  ✗ PATCH ${r.id} → ${resp.status} ${await resp.text()}`)
  }
}

// ---------- main ----------
const clusters = selectClusters(await fetchAllLeads())
console.log(`${clusters.length} cluster(s) to trace${DRY ? " (dry run)" : ""}`)
if (!clusters.length) process.exit(0)
// Fresh context, NOT a persistent profile: with a saved profile FPS's
// "Loading Search Results…" splash never resolved (2026-08-27); a clean
// context loads fine. One context for the whole run.
const browser = await chromium.launch({ channel: "chrome", headless: false })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
const report = []
for (const [i, c] of clusters.entries()) {
  process.stdout.write(`[${i + 1}/${clusters.length}] ${c.phone} (${c.rows[0].source}) … `)
  let res
  try { res = await scrapePhone(page, c.phone) } catch (e) { res = { status: `error: ${e.message.split("\n")[0]}`, persons: [] } }
  const flags = res.status === "ok" ? flagsFor(res.persons) : []
  console.log(res.status === "ok" ? `${res.persons.length} person(s)${flags.length ? `  ⚑ ${flags.length} flag(s)` : ""}` : res.status)
  // Only durable outcomes get written; a transient error/challenge must not
  // stamp the cluster (the marker would make later runs skip it).
  if (res.status === "ok" || res.status === "no_record") await writeCluster(c, res)
  else console.log(`   (not written — ${res.status})`)
  report.push({ phone: c.phone, source: c.rows[0].source, status: res.status, flags, persons: res.persons.map((p) => ({ name: p.name, age: p.age, deceased: p.deceased, current: p.current?.address, previous: (p.previous || []).map((a) => a.address) })) })
  fs.writeFileSync("scripts/.skip-trace-report.json", JSON.stringify(report, null, 1))
  if (i < clusters.length - 1) await sleep(jitter(8000, 20000))
}
await browser.close()
const ok = report.filter((r) => r.status === "ok").length
console.log(`\ndone: ${ok} found, ${report.length - ok} misses, ${report.filter((r) => r.flags.length).length} flagged → scripts/.skip-trace-report.json`)
