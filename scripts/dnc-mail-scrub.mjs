#!/usr/bin/env node
// Live do-not-contact scrub for direct-mail lists (2026-11-03). Replaces the
// out-of-repo _tmp_dm2026/step2_dnc.py, which read a frozen Oct 8 snapshot
// and matched site addresses exactly.
//
//   node scripts/dnc-mail-scrub.mjs --campaign <campaign_id|all> [--env <.env.local>] [--self-test]
//   node scripts/dnc-mail-scrub.mjs --csv <mailing.csv> --out <scrubbed.csv> [--env <.env.local>]
//
// Mode A (--campaign): every non-seed mail_records row of the campaign (or of
//   every campaign) is checked against the live `suppression` table. Report
//   only — nothing is written anywhere.
// Mode B (--csv): a vendor mailing file is scrubbed. Writes --out (kept
//   rows, original columns), <out>.removed.csv (removed rows + match_rule /
//   dnc_ref / dnc_value) and, when there are any, <out>.review.csv (owner-
//   name hits that were NOT removed). The DB is only read.
//
// Suppression rows apply to mail when channel is 'mail' or 'all'. Rules, in
// order (a record reports its first rule; every suppression row it hit is
// listed):
//   1 parcel        APN equal after normApn (digit-group shape and county
//                   must agree when both sides carry them — SCC 3-2-3 and
//                   Santa Cruz 3-3-2 APNs can collide once dashes go)
//   2 site_address  site street equal after normStreetDir (normStreet +
//                   NORTH→N + wider suffix map); zip, else city, must agree
//                   when both sides have one
//   3 mail_address  mailing street + city (or zip) equal. The DNC row's
//                   site address is also tried against the record's mailing
//                   address ("site_as_mail") — the person who asked lives there.
//   4 fuzzy_site    same house number + same directional (if either side
//                   has one) + street name's first letter, and the DNC row
//                   has no city or the city matches — counted only when it
//                   lands on exactly ONE property in the scope (the campaign,
//                   or the CSV). A whole-word DNC street must also look
//                   like the record's (3-letter prefix / <= 2 edits) or the
//                   hit drops to the review bucket as fuzzy_weak — the
//                   first letter alone matched "489 Sweets Dr" to "489 Sioux
//                   Ln". Removed, but listed for Ryan's review.
//   5 owner_name    >= 2 owner-name tokens equal (trust words stripped on
//                   both sides). REVIEW ONLY — never removed.
// Rows with only a phone / email can't scrub mail; they're counted.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { normCity, normApn, parseFreeAddress, normStreetDir, ownerNameTokens, DIRECTIONALS } from "../lib/mailMatch.ts"
import { parseCsv } from "../lib/csv.ts"

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null }
const flag = (k) => argv.includes(k)
const campaignArg = arg("--campaign"), csvPath = arg("--csv"), outPath = arg("--out"), envPath = arg("--env")
const selfTest = flag("--self-test")
if ((!campaignArg && !csvPath) || (campaignArg && csvPath) || (csvPath && !outPath)) {
  console.error("usage:\n  node scripts/dnc-mail-scrub.mjs --campaign <campaign_id|all> [--env <.env.local>] [--self-test]\n  node scripts/dnc-mail-scrub.mjs --csv <mailing.csv> --out <scrubbed.csv> [--env <.env.local>]")
  process.exit(1)
}

// ── env ───────────────────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url))
const envCandidates = envPath ? [envPath] : [path.resolve(here, "../.env.local"), path.resolve(process.cwd(), ".env.local")]
if (!process.env.LRG_SUPABASE_URL || !process.env.LRG_SUPABASE_SERVICE_KEY || envPath) {
  const f = envCandidates.find((p) => fs.existsSync(p))
  if (!f) { console.error(`No env file found (tried ${envCandidates.join(", ")}); pass --env <path to .env.local>`); process.exit(1) }
  process.loadEnvFile(f)
}
const SB_URL = process.env.LRG_SUPABASE_URL, SB_KEY = process.env.LRG_SUPABASE_SERVICE_KEY
if (!SB_URL || !SB_KEY) { console.error("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing"); process.exit(1) }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } })

/** Every row past PostgREST's 1000-row default cap. `build` must return a fresh query on a table with an `id`;
 *  the order is stated here as well so the ordered-paging guard can see it. */
async function fetchAll(build, page = 1000) {
  const out = []
  for (let from = 0; ; from += page) {
    const { data, error } = await build().order("id").range(from, from + page - 1)
    if (error) throw new Error(error.message)
    out.push(...data)
    if (data.length < page) return out
  }
}

// ── normalizers ─────────────────────────────────────────────────────────
const zip5 = (s) => { const m = String(s ?? "").match(/\b(\d{5})(?:-\d{4})?\b/); return m ? m[1] : "" }
const cityKey = (s) => normCity(s).replace(/\b(CA|CALIFORNIA)\b/g, "").replace(/\s+/g, " ").trim()
const countyKey = (s) => normCity(s).replace(/\bCOUNTY\b/g, "").trim()
const apnShape = (s) => { const g = String(s ?? "").trim().split(/[^0-9A-Za-z]+/).filter(Boolean); return g.length > 1 ? g.map((x) => x.length).join("-") : "" }

/** "765 N BRANCIFORTE AVE" → { num: "765", dir: "N", name: "BRANCIFORTE" } */
function streetParts(street) {
  const t = street.split(" ").filter(Boolean)
  const num = /^\d+[A-Z]?$/.test(t[0] ?? "") ? t[0] : ""
  if (!num) return { num: "", dir: "", name: "" }
  const dir = DIRECTIONALS.has(t[1]) && t.length > 2 ? t[1] : ""
  return { num, dir, name: t[dir ? 2 : 1] ?? "" }
}

/** One address: street key + city / zip + fuzzy parts. `raw` may carry ", City ST zip". */
function makeAddr(raw, cityField, zipField) {
  const r = String(raw ?? "").replace(/\(.*?\)/g, " ").trim()
  if (!r) return null
  const p = parseFreeAddress(r)
  const street = normStreetDir(p.street)
  const cf = cityKey(cityField)
  const city = cf && !/^\d{5}$/.test(cf) ? cf : cityKey(p.city)
  const zip = zip5(zipField) || (/^\d{5}$/.test(cf) ? cf : "") || p.zip
  return { street, city, zip, raw: String(raw).trim(), ...streetParts(street) }
}

/**
 * The free-text DNC fields Ryan's tools write: "931 Harless Ave / 1019-1021
 * Spencer Ave", "147 Cappuccino/Capuchino Drive", city "Redwood City / 214
 * Raymundo Dr", city "95127". Each '/' part with a house number is its own
 * address; a part without one borrows the first part's number (an alternate
 * spelling); a number range expands to both ends.
 */
function expandAddrs(rawAddr, rawCity, rawZip) {
  const out = []
  const cityParts = String(rawCity ?? "").split("/").map((s) => s.trim()).filter(Boolean)
  const city = cityParts.length && !/^\d/.test(cityParts[0]) ? cityParts[0] : ""
  const cityZip = cityParts.find((c) => /^\d{5}$/.test(c)) ?? ""
  const extras = cityParts.filter((c) => /^\d+\s+\S/.test(c))
  const parts = String(rawAddr ?? "").split("/").map((s) => s.trim()).filter(Boolean)
  const firstNum = (parts[0] ?? "").match(/^(\d+)\s/)?.[1] ?? ""
  const strings = []
  for (const part of parts) {
    const s = /^\d/.test(part) || !firstNum || part === parts[0] ? part : `${firstNum} ${part}`
    const rng = s.match(/^(\d+)\s*-\s*(\d+)\s+(.+)$/)
    if (rng) strings.push(`${rng[1]} ${rng[3]}`, `${rng[2]} ${rng[3]}`)
    else strings.push(s)
  }
  for (const s of strings) { const a = makeAddr(s, city || cityZip, rawZip); if (a) out.push(a) }
  for (const s of extras) { const a = makeAddr(s, "", ""); if (a) out.push(a) }
  return out
}

// ── suppression → entries ─────────────────────────────────────────────────
// Duplicate rows (lead_dnc + dnc_list for the same person) collapse into one
// entry carrying every row's id / source.
function buildEntries(rows) {
  const kinds = { total: rows.length, parcel: 0, site: 0, siteNoNumber: 0, mail: 0, phoneEmailOnly: 0, nameOnly: 0, noKey: 0 }
  const siteNoNumber = []
  const byKey = new Map()
  for (const r of rows) {
    const apn = normApn(r.parcel_number)
    const sites = expandAddrs(r.site_address, r.site_city, r.site_zip)
    const goodSites = sites.filter((a) => a.num)
    const mails = expandAddrs(r.mail_address, r.mail_city, r.mail_zip).filter((a) => a.num)
    const nameToks = ownerNameTokens(r.name)
    if (apn) kinds.parcel++
    if (goodSites.length) kinds.site++
    else if (r.site_address) { kinds.siteNoNumber++; siteNoNumber.push(r.site_address) }
    if (mails.length) kinds.mail++
    const hasAddrKey = apn || goodSites.length || mails.length
    if (!hasAddrKey) {
      if (r.phone || r.email) kinds.phoneEmailOnly++
      else if (nameToks.length >= 2) kinds.nameOnly++
      else kinds.noKey++
    }
    const key = JSON.stringify([apn, goodSites.map((a) => `${a.street}|${a.city}|${a.zip}`), mails.map((a) => `${a.street}|${a.city}|${a.zip}`), [...nameToks].sort()])
    let e = byKey.get(key)
    if (!e) {
      e = { ids: [], sources: new Set(), reasons: new Set(), name: r.name, rawSite: r.site_address, rawSiteCity: r.site_city, rawMail: r.mail_address, rawParcel: r.parcel_number,
        apn, apnShape: apnShape(r.parcel_number), county: countyKey(r.county), sites: goodSites, mails, nameToks: nameToks.length >= 2 ? nameToks : [] }
      byKey.set(key, e)
    }
    e.ids.push(r.id); e.sources.add(r.source); if (r.reason) e.reasons.add(r.reason)
  }
  return { entries: [...byKey.values()], kinds, siteNoNumber }
}

const entryRef = (e) => `${e.ids.map((id) => String(id).slice(0, 8)).join("+")} [${[...e.sources].join(",")}]`
function entryValue(e, rule, detail = "") {
  if (rule === "parcel") return `APN ${e.rawParcel}`
  if (rule === "mail_address" && detail !== "site_as_mail") return `mail: ${e.rawMail}`
  if (rule === "owner_name") return `name: ${e.name}`
  return `${e.rawSite ?? ""}${e.rawSiteCity ? `, ${e.rawSiteCity}` : ""}`
}

// ── records ──────────────────────────────────────────────────────────────
// Common shape for a mail_records row or a CSV row.
function makeRecord({ ref, scope, apnRaw, county, siteRaw, siteCity, siteZip, mailRaw, mailCity, mailZip, owners, display, extra }) {
  const site = makeAddr(siteRaw, siteCity, siteZip)
  const mail = makeAddr(mailRaw, mailCity, mailZip)
  return {
    ref, scope, display, extra,
    apn: normApn(apnRaw), apnShape: apnShape(apnRaw), county: countyKey(county),
    site: site && site.num ? site : null,
    mail: mail && mail.num ? mail : null,
    propKey: site ? `${site.street}|${site.city}` : `ref:${ref}`,
    ownerToks: owners.filter(Boolean).map((o) => ownerNameTokens(o)).filter((t) => t.length),
  }
}

// ── matcher ──────────────────────────────────────────────────────────────
const RULES = ["parcel", "site_address", "mail_address", "fuzzy_site"]
const pushMap = (m, k, v) => { if (!k) return; const a = m.get(k); if (a) a.push(v); else m.set(k, [v]) }

/** Zip decides when both sides have one; otherwise city, when both have one. */
function siteLocOk(a, r) {
  if (a.zip && r.zip) return a.zip === r.zip
  if (a.city && r.city) return a.city === r.city
  return true
}
const mailLocOk = (a, r) => (a.zip && r.zip && a.zip === r.zip) || (a.city && r.city && a.city === r.city)

function sharedPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i }
function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}
/**
 * Fuzzy guard on top of the first-letter rule. A garbled / abbreviated DNC
 * street ("B40", "B") passes on its first letter; a whole word ("SWEETS",
 * "HOLLY") must look like the record's street (shared 3-letter prefix, one is
 * a prefix of the other, or <= 2 edits) — otherwise "489 Sweets Dr" removes
 * "489 Sioux Ln". Ordinals ("24TH") must be the same number.
 */
function streetNamesAgree(dnc, rec) {
  if (/^\d/.test(dnc)) return dnc.replace(/\D.*$/, "") === rec.replace(/\D.*$/, "")
  if (!/^[A-Z]{3,}$/.test(dnc)) return true
  return rec.startsWith(dnc) || dnc.startsWith(rec) || sharedPrefix(dnc, rec) >= 3 || lev(dnc, rec) <= 2
}
/** House number + directional + first letter: the fuzzy key, used to annotate review hits. */
const looseSame = (a, b) => a && b && a.num === b.num && a.dir === b.dir && a.name && b.name && a.name[0] === b.name[0]

function runMatch(entries, records) {
  // hits: record → [{ rule, entry, detail }]
  const hits = new Map()
  const addHit = (rec, rule, entry, detail = "") => {
    const list = hits.get(rec) ?? []
    if (!list.some((h) => h.entry === entry && h.rule === rule)) list.push({ rule, entry, detail })
    hits.set(rec, list)
  }
  const review = [] // { rec, entry, rule: "owner_name" | "fuzzy_weak", detail }
  const fuzzyNearMiss = [] // { entry, addr, props }

  const scopes = new Map()
  for (const r of records) pushMap(scopes, r.scope, r)
  for (const recs of scopes.values()) {
    const byApn = new Map(), bySite = new Map(), byMail = new Map(), byNum = new Map(), byTok = new Map()
    recs.forEach((r, i) => { r._idx = i })
    for (const r of recs) {
      pushMap(byApn, r.apn, r)
      if (r.site) { pushMap(bySite, r.site.street, r); pushMap(byNum, r.site.num, r) }
      if (r.mail) pushMap(byMail, r.mail.street, r)
      r.ownerToks.forEach((toks, i) => toks.forEach((t) => pushMap(byTok, t, [r, i])))
    }
    for (const e of entries) {
      // 1 parcel
      if (e.apn && e.apn.length >= 6) {
        for (const r of byApn.get(e.apn) ?? []) {
          if (e.apnShape && r.apnShape && e.apnShape !== r.apnShape) continue
          if (e.county && r.county && e.county !== r.county) continue
          addHit(r, "parcel", e, r.display.apn)
        }
      }
      // 2 site street
      for (const a of e.sites) {
        for (const r of bySite.get(a.street) ?? []) if (siteLocOk(a, r.site)) addHit(r, "site_address", e, a.city || a.zip ? "" : "DNC row has no city")
      }
      // 3 mailing street (+ the DNC site address as a mailing address)
      for (const a of e.mails) for (const r of byMail.get(a.street) ?? []) if (mailLocOk(a, r.mail)) addHit(r, "mail_address", e)
      for (const a of e.sites) for (const r of byMail.get(a.street) ?? []) if (mailLocOk(a, r.mail)) addHit(r, "mail_address", e, "site_as_mail")
      // 4 fuzzy site — unique property in scope only
      for (const a of e.sites) {
        if (!a.name) continue
        // An exact street hit already settled this address; fuzzy would only echo it.
        if ((bySite.get(a.street) ?? []).some((r) => siteLocOk(a, r.site))) continue
        const cands = (byNum.get(a.num) ?? []).filter((r) => {
          const s = r.site
          if ((a.dir || s.dir) && a.dir !== s.dir) return false
          if (!s.name || s.name[0] !== a.name[0]) return false
          if (a.city) return a.city === s.city
          if (a.zip && s.zip) return a.zip === s.zip
          return true
        })
        const props = new Set(cands.map((r) => r.propKey))
        if (props.size === 1) {
          for (const r of cands) {
            const detail = `${a.street}${a.city ? `, ${a.city}` : " (no city)"} ~ ${r.site.street}, ${r.site.city}`
            if (streetNamesAgree(a.name, r.site.name)) addHit(r, "fuzzy_site", e, detail)
            else review.push({ rec: r, entry: e, rule: "fuzzy_weak", detail: `${detail} — only the first letter agrees` })
          }
        } else if (props.size > 1 && props.size <= 6) fuzzyNearMiss.push({ entry: e, addr: a, props: [...props] })
      }
    }
    // 5 owner name — review only
    for (const e of entries) {
      if (!e.nameToks.length) continue
      const count = new Map()
      for (const t of e.nameToks) for (const [r, i] of byTok.get(t) ?? []) { const k = `${r._idx}:${i}`; const c = count.get(k) ?? { r, n: 0, toks: [] }; c.n++; c.toks.push(t); count.set(k, c) }
      const seen = new Set()
      for (const { r, n, toks } of count.values()) {
        if (n < 2 || seen.has(r)) continue
        seen.add(r)
        const addrs = [...e.sites, ...e.mails]
        const cities = addrs.map((a) => a.city).filter(Boolean)
        const notes = [`shared: ${toks.join(" ")}`]
        if (cities.length) notes.push(cities.some((c) => c === r.site?.city || c === r.mail?.city) ? "city agrees" : "city differs")
        for (const a of addrs) for (const [side, x] of [["site", r.site], ["mail", r.mail]]) {
          if (looseSame(a, x)) notes.push(`ADDRESS LOOK-ALIKE: DNC ${a.street} ~ record ${side} ${x.street}`)
        }
        review.push({ rec: r, entry: e, rule: "owner_name", detail: notes.join("; ") })
      }
    }
  }
  const matched = [...hits.entries()].map(([rec, list]) => {
    list.sort((x, y) => RULES.indexOf(x.rule) - RULES.indexOf(y.rule))
    return { rec, rule: list[0].rule, hits: list }
  }).sort((x, y) => RULES.indexOf(x.rule) - RULES.indexOf(y.rule) || String(x.rec.ref).localeCompare(String(y.rec.ref)))
  const removedSet = new Set(matched.map((m) => m.rec))
  // A record already removed doesn't need review; strongest notes first.
  const rank = (v) => (/LOOK-ALIKE/.test(v.detail) ? 0 : v.rule === "fuzzy_weak" ? 1 : /city agrees/.test(v.detail) ? 2 : 3)
  return { matched, review: review.filter((v) => !removedSet.has(v.rec)).sort((x, y) => rank(x) - rank(y)), fuzzyNearMiss }
}

// ── reporting ─────────────────────────────────────────────────────────────
function printKinds(kinds, siteNoNumber, entries) {
  console.log(`\nSuppression rows for mail (channel mail|all): ${kinds.total}  →  ${entries.filter((e) => e.apn || e.sites.length || e.mails.length).length} distinct address keys after collapsing duplicates`)
  console.log(`  with parcel:                ${kinds.parcel}`)
  console.log(`  with usable site address:   ${kinds.site}`)
  console.log(`  with mailing address:       ${kinds.mail}`)
  console.log(`  site text, no house number: ${kinds.siteNoNumber}${siteNoNumber.length ? `  (${[...new Set(siteNoNumber)].map((s) => JSON.stringify(s)).join(", ")})` : ""}`)
  console.log(`  phone/email only (can't scrub mail): ${kinds.phoneEmailOnly}`)
  console.log(`  name only (review bucket only):      ${kinds.nameOnly}`)
  console.log(`  no usable key at all:                ${kinds.noKey}`)
}

const recLine = (r) => `${r.ref}${r.extra ? ` ${r.extra}` : ""} | ${r.display.owner ?? ""} | ${r.display.site ?? ""} | mail: ${r.display.mail ?? ""}`

function printReport({ matched, review, fuzzyNearMiss }, entries, records) {
  const perRule = Object.fromEntries(RULES.map((r) => [r, 0]))
  for (const m of matched) perRule[m.rule]++
  console.log(`\nRecords checked: ${records.length}`)
  console.log(`Records matched (would be removed): ${matched.length}`)
  for (const r of RULES) console.log(`  ${r.padEnd(13)} ${perRule[r]}`)
  console.log(`Review bucket (NOT removed): ${review.filter((v) => v.rule === "owner_name").length} owner_name, ${review.filter((v) => v.rule === "fuzzy_weak").length} fuzzy_weak`)

  if (matched.length) {
    console.log(`\n── Matched records ──`)
    for (const m of matched) {
      console.log(`[${m.rule}] ${recLine(m.rec)}`)
      for (const h of m.hits) console.log(`      ↳ ${h.rule}: ${entryValue(h.entry, h.rule, h.detail)}  — ${entryRef(h.entry)}${h.detail ? `  (${h.detail})` : ""}`)
    }
  }

  // Over-broad: one DNC entry removing more than one property.
  const perEntry = new Map()
  for (const m of matched) for (const h of m.hits) { const s = perEntry.get(h.entry) ?? new Set(); s.add(m.rec.propKey); perEntry.set(h.entry, s) }
  const broad = [...perEntry.entries()].filter(([, s]) => s.size > 1)
  if (broad.length) {
    console.log(`\n── DNC rows hitting more than one property (check these) ──`)
    for (const [e, s] of broad) console.log(`  ${entryValue(e, "site")} — ${entryRef(e)} → ${s.size} properties: ${[...s].join(" ; ")}`)
  }
  const fuzzy = matched.filter((m) => m.rule === "fuzzy_site")
  if (fuzzy.length) console.log(`\n${fuzzy.length} fuzzy_site removal(s) above — Ryan to eyeball.`)

  if (review.length) {
    console.log(`\n── Review bucket (not removed; strongest first) ──`)
    const byEntry = new Map()
    for (const v of review) pushMap(byEntry, v.entry, v)
    for (const [e, list] of byEntry) {
      console.log(`  ${e.name ?? entryValue(e, "site")} — ${entryRef(e)}${e.rawSite ? ` (DNC addr: ${entryValue(e, "site")})` : ""} → ${list.length} record(s)`)
      for (const v of list.slice(0, 8)) console.log(`      [${v.rule}] ${recLine(v.rec)}  [${v.detail}]`)
      if (list.length > 8) console.log(`      … ${list.length - 8} more`)
    }
  }

  const hitEntries = new Set(matched.flatMap((m) => m.hits.map((h) => h.entry)))
  const unmatched = entries.filter((e) => (e.apn || e.sites.length || e.mails.length) && !hitEntries.has(e))
  console.log(`\n── DNC address rows with no record in this scope (${unmatched.length}) ──`)
  const near = new Map(fuzzyNearMiss.map((n) => [n.entry, n]))
  for (const e of unmatched) {
    const n = near.get(e)
    console.log(`  ${entryValue(e, e.sites.length ? "site" : e.mails.length ? "mail_address" : "parcel")} — ${entryRef(e)}${n ? `  (fuzzy ambiguous: ${n.props.length} candidates: ${n.props.join(" ; ")})` : ""}`)
  }
}

// ── load suppression ─────────────────────────────────────────────────────
const supRows = await fetchAll(() => sb.from("suppression").select("id, email, phone, name, parcel_number, site_address, site_city, site_state, site_zip, mail_address, mail_city, mail_state, mail_zip, county, reason, source, channel").in("channel", ["mail", "all"]).order("id"))
const { entries, kinds, siteNoNumber } = buildEntries(supRows)

if (campaignArg) {
  // ── Mode A ──
  const campaigns = await fetchAll(() => sb.from("campaigns").select("id, name, parent_campaign_id").order("id"))
  const cname = new Map(campaigns.map((c) => [c.id, c.name]))
  if (campaignArg !== "all" && !cname.has(campaignArg)) { console.error(`Unknown campaign ${campaignArg}`); process.exit(1) }
  const cols = "id, campaign_id, record_id, parcel_number, owner_name, owner_name2, site_address, site_city, site_zip, mail_address, mail_city, mail_state, mail_zip, county, arm, batch, is_seed"
  const rows = await fetchAll(() => {
    let q = sb.from("mail_records").select(cols).eq("is_seed", false).order("id")
    if (campaignArg !== "all") q = q.eq("campaign_id", campaignArg)
    return q
  })
  const records = rows.map((r) => makeRecord({
    ref: r.record_id ?? r.id, scope: r.campaign_id, apnRaw: r.parcel_number, county: r.county,
    siteRaw: r.site_address, siteCity: r.site_city, siteZip: r.site_zip,
    mailRaw: r.mail_address, mailCity: r.mail_city, mailZip: r.mail_zip,
    owners: [r.owner_name, r.owner_name2 && r.owner_name2 !== r.owner_name ? r.owner_name2 : null],
    extra: `(arm ${r.arm}${r.batch != null ? `, batch ${r.batch}` : ""}${campaignArg === "all" ? `, ${cname.get(r.campaign_id) ?? r.campaign_id}` : ""})`,
    display: { owner: r.owner_name, site: [r.site_address, r.site_city, r.site_zip].filter(Boolean).join(", "), mail: [r.mail_address, r.mail_city, r.mail_state, r.mail_zip].filter(Boolean).join(", "), apn: r.parcel_number ?? "" },
  }))
  const scopeNames = campaignArg === "all" ? [...new Set(rows.map((r) => r.campaign_id))].map((id) => cname.get(id) ?? id) : [cname.get(campaignArg)]
  console.log(`DNC mail scrub — live suppression × mail_records (read-only) — ${new Date().toISOString()}`)
  console.log(`Scope: ${campaignArg === "all" ? `all campaigns with records (${scopeNames.join("; ")})` : `${scopeNames[0]} (${campaignArg})`}; seeds excluded`)
  printKinds(kinds, siteNoNumber, entries)
  printReport(runMatch(entries, records), entries, records)

  if (selfTest) {
    // In-memory only: synthetic DNC rows, never written.
    console.log(`\n── Self-test (synthetic DNC rows, in memory) ──`)
    const cases = [
      { label: '"765 N B40", no city → fuzzy_site', row: { id: "selftest-fuzzy", site_address: "765 N B40", source: "selftest" }, want: "fuzzy_site" },
      { label: '"765 N Branciforte Ave" + APN 010-021-01 → parcel', row: { id: "selftest-parcel", site_address: "765 N Branciforte Ave", parcel_number: "010-021-01", source: "selftest" }, want: "parcel" },
      { label: '"765 North Branciforte Avenue, Santa Cruz" → site_address', row: { id: "selftest-dir", site_address: "765 North Branciforte Avenue, Santa Cruz", source: "selftest" }, want: "site_address" },
    ]
    let fail = 0
    for (const c of cases) {
      const t = buildEntries([c.row])
      const res = runMatch(t.entries, records)
      const got = res.matched.map((m) => `${m.rec.ref}:${m.rule}`)
      const ok = res.matched.length >= 1 && res.matched.every((m) => m.rule === c.want) && res.matched.some((m) => /Branciforte/i.test(m.rec.display.site))
      if (!ok) fail++
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.label}  → ${got.join(", ") || "no match"}`)
    }
    if (fail) process.exitCode = 1
  }
} else {
  // ── Mode B ──
  const parsed = parseCsv(fs.readFileSync(csvPath, "utf8"))
  const hdr = parsed[0].map((h) => h.trim())
  const body = parsed.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""))
  const hk = hdr.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""))
  const pick = (...names) => { for (const n of names) { const i = hk.indexOf(n); if (i > -1) return i } return -1 }
  const col = {
    apn: pick("parcelnumber", "apn", "parcel", "parcelno", "parcelid", "assessorparcelnumber", "apnformatted"),
    site: pick("siteaddress", "propertyaddress", "situsaddress", "siteaddr", "sitestreet", "propertystreet", "address"),
    siteCity: pick("siteaddresscity", "sitecity", "propertycity", "propertyaddresscity", "situscity", "city"),
    siteZip: pick("siteaddresszip", "sitezip", "propertyzip", "propertyaddresszip", "situszip", "zip", "zipcode"),
    mail: pick("fullmailaddress", "mailaddress", "mailingaddress", "mailaddressline1", "mailingstreet", "mailstreet", "mailingaddressline1"),
    mailCity: pick("mailaddresscity", "mailcity", "mailingcity", "mailingaddresscity"),
    mailZip: pick("mailaddresszip", "mailzip", "mailingzip", "mailingaddresszip", "mailzipcode"),
    owner: pick("ownername", "owner", "ownerfullname", "owner1fullname", "owner1name", "ownernames"),
    owner2: pick("ownername2", "owner2name", "owner2fullname"),
    o1first: pick("owner1firstname"), o1last: pick("owner1lastname"),
    county: pick("sourcecounty", "county"),
    recordId: pick("recordid"),
    seed: pick("isseed"),
  }
  console.log(`DNC mail scrub — live suppression × ${csvPath} — ${new Date().toISOString()}`)
  console.log(`Columns detected: ${Object.entries(col).filter(([, i]) => i > -1).map(([k, i]) => `${k}="${hdr[i]}"`).join(", ")}`)
  if (col.apn < 0 && col.site < 0 && col.mail < 0) { console.error("No parcel / site address / mailing address column found."); process.exit(1) }
  const v = (row, i) => (i > -1 ? String(row[i] ?? "").trim() : "")
  const records = body.map((row, n) => {
    const owner = v(row, col.owner) || [v(row, col.o1first), v(row, col.o1last)].filter(Boolean).join(" ")
    const rec = makeRecord({
      ref: v(row, col.recordId) || `row ${n + 2}`, scope: "csv", apnRaw: v(row, col.apn), county: v(row, col.county),
      siteRaw: v(row, col.site), siteCity: v(row, col.siteCity), siteZip: v(row, col.siteZip),
      mailRaw: v(row, col.mail), mailCity: v(row, col.mailCity), mailZip: v(row, col.mailZip),
      owners: [owner, v(row, col.owner2) !== owner ? v(row, col.owner2) : ""],
      display: { owner, site: [v(row, col.site), v(row, col.siteCity), v(row, col.siteZip)].filter(Boolean).join(", "), mail: [v(row, col.mail), v(row, col.mailCity), v(row, col.mailZip)].filter(Boolean).join(", "), apn: v(row, col.apn) },
    })
    rec.row = row
    rec.isSeed = /^(true|t|1|y|yes)$/i.test(v(row, col.seed))
    return rec
  })
  const checkable = records.filter((r) => !r.isSeed)
  printKinds(kinds, siteNoNumber, entries)
  const result = runMatch(entries, checkable)
  printReport(result, entries, checkable)

  const esc = (s) => { const t = String(s ?? ""); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
  const line = (cells) => cells.map(esc).join(",")
  const uniq = (xs) => [...new Set(xs)].join("; ")
  const removed = new Map(result.matched.map((m) => [m.rec, m]))
  const kept = records.filter((r) => !removed.has(r))
  const base = outPath.replace(/\.csv$/i, "")
  const removedPath = `${base}.removed.csv`, reviewPath = `${base}.review.csv`
  fs.writeFileSync(outPath, [line(hdr), ...kept.map((r) => line(r.row))].join("\n") + "\n")
  fs.writeFileSync(removedPath, [line([...hdr, "match_rule", "dnc_ref", "dnc_value", "match_detail"]),
    ...result.matched.map((m) => line([...m.rec.row, uniq(m.hits.map((h) => h.rule)), uniq(m.hits.map((h) => entryRef(h.entry))), uniq(m.hits.map((h) => entryValue(h.entry, h.rule, h.detail))), uniq(m.hits.map((h) => h.detail).filter(Boolean))]))].join("\n") + "\n")
  if (result.review.length) {
    fs.writeFileSync(reviewPath, [line([...hdr, "match_rule", "dnc_ref", "dnc_name", "dnc_value", "match_detail"]),
      ...result.review.map((x) => line([...x.rec.row, `${x.rule} (review)`, entryRef(x.entry), x.entry.name ?? "", entryValue(x.entry, "site"), x.detail]))].join("\n") + "\n")
  }
  console.log(`\nReconcile: ${records.length} in = ${kept.length} kept + ${removed.size} removed (${records.length === kept.length + removed.size ? "ties" : "DOES NOT TIE"})`)
  console.log(`Wrote ${outPath}\nWrote ${removedPath}${result.review.length ? `\nWrote ${reviewPath}` : ""}`)
}
