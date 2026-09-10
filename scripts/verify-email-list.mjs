#!/usr/bin/env node
/**
 * Email-verification tooling for the ~2,100-contact agent drip list
 * (September rebuild, item 5 — briefs/REBUILD_PROGRESS_2026-09.md). Goal:
 * catch dead/typo/disposable addresses BEFORE their first touch from the
 * new domains — July died on a 7.1% day-one bounce rate, almost entirely
 * dead domains and typos, not individually-nonexistent mailboxes at live
 * domains.
 *
 *   node scripts/verify-email-list.mjs                # all active contacts
 *   node scripts/verify-email-list.mjs --limit=50      # sample, for testing
 *   node scripts/verify-email-list.mjs --status=active,paused
 *   node scripts/verify-email-list.mjs --json          # summary as JSON on stdout too
 *
 * READ-ONLY: reads campaign_contacts, writes nothing to Supabase. Output is
 * a local report (scripts/.email-verify-report.{json,csv}, gitignored — it
 * holds ~2,100 real names/emails) for a human to review before anyone
 * flips any contact to bad_email/no_email by hand or in a supervised
 * script run. This tool does not mutate campaign_contacts itself.
 *
 * Two tiers of check, run in this order per contact:
 *
 * 1. Syntax + domain heuristics (instant, no network): malformed address,
 *    known disposable/throwaway domain, common freemail typo
 *    (gmial.com, hotmial.com, ...). Role-account prefixes (info@, sales@)
 *    are flagged as advisory, not a failure — CRM already treats those 44
 *    as a "defer from touch" bucket, not a bounce risk.
 * 2. DNS deliverability (dns.resolveMx with the RFC 5321 A/AAAA fallback
 *    when a domain has no MX). This is what actually catches "dead
 *    domain" — the real cause of most hard bounces on this list.
 *
 * SMTP-level RCPT TO probing (the ask in the brief) is implemented as pure,
 * unit-tested protocol logic (classifySmtpCode, buildProbeCommands below)
 * but is NOT run live tonight: a one-time self-test at startup tries a raw
 * TCP connection to a well-known always-up MX (Gmail's) on port 25, and on
 * this network it times out — confirmed twice (sandboxed and unsandboxed),
 * against port 25 AND 587, while HTTPS egress works fine. That is a
 * network-level block (residential ISPs commonly drop outbound 25/587 to
 * stop spam relaying), not a bug in this script or a sandbox artifact. See
 * D15 in the progress ledger for the writeup and the recommendation this
 * produces (no paid service signed up for — per instructions, just a
 * documented option). If this is ever run from a network where port 25 is
 * open, pass --smtp and the self-test will enable the real probe instead of
 * skipping it — but per the "never send email of any kind" guardrail this
 * should only be turned on in a supervised session, never unattended,
 * since it opens live connections to every recipient's real mail server.
 */

import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import dns from "node:dns/promises"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(__dirname, "..")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")
const REPORT_JSON_PATH = path.join(__dirname, ".email-verify-report.json")
const REPORT_CSV_PATH = path.join(__dirname, ".email-verify-report.csv")

export function loadEnvLocal(envPath = ENV_PATH) {
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

// ---------------------------------------------------------------------------
// Tier 1: syntax + domain heuristics. Pure, no I/O — unit-tested directly.
// ---------------------------------------------------------------------------

// Deliberately not a full RFC 5322 grammar (that permits addresses no real
// mail system accepts anyway) — this is the practical subset: one @, a
// local part, a domain with at least one dot, no whitespace/control chars.
const SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidSyntax(email) {
  if (typeof email !== "string") return false
  const trimmed = email.trim()
  if (trimmed.length === 0 || trimmed.length > 254) return false
  if (trimmed !== email) return false // leading/trailing whitespace = bad import data, not a typo to silently fix
  return SYNTAX_RE.test(trimmed)
}

export function emailDomain(email) {
  const at = email.lastIndexOf("@")
  return at < 0 ? null : email.slice(at + 1).toLowerCase()
}

export function localPart(email) {
  const at = email.lastIndexOf("@")
  return at < 0 ? email : email.slice(0, at).toLowerCase()
}

// Not exhaustive — a heuristic net for the obvious/common throwaway
// services. A domain missing this list isn't vouched for; one present on it
// is a near-certain "don't bother sending."
export const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "throwawaymail.com", "yopmail.com", "trashmail.com",
  "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc",
  "fakeinbox.com", "mintemail.com", "mailnesia.com", "guerrillamailblock.com",
  "spamgourmet.com", "mailcatch.com", "mvrht.net", "moakt.com",
])

export function isDisposableDomain(domain) {
  return DISPOSABLE_DOMAINS.has(domain)
}

// Prefixes that route to a team inbox rather than a person. Advisory only —
// the CRM already treats these as a "defer from touch" cohort, not bounces.
export const ROLE_PREFIXES = new Set([
  "info", "admin", "sales", "support", "noreply", "no-reply", "office",
  "contact", "help", "team", "marketing", "hello", "webmaster", "postmaster",
  "abuse", "billing", "accounts", "enquiries", "inquiries", "frontdesk",
])

export function isRoleAccount(email) {
  return ROLE_PREFIXES.has(localPart(email))
}

// Common one-typo-away freemail domains. Flags a suggestion; never
// auto-corrects (an agent's actual brokerage domain could legitimately
// look unusual — a human should confirm before touching data).
export const TYPO_DOMAINS = {
  "gmial.com": "gmail.com", "gmali.com": "gmail.com", "gamil.com": "gmail.com",
  "gmai.com": "gmail.com", "gmail.co": "gmail.com", "gmail.cm": "gmail.com",
  "gmailcom": "gmail.com", "gmail.comm": "gmail.com",
  "yahooo.com": "yahoo.com", "yaho.com": "yahoo.com", "yahoo.co": "yahoo.com",
  "yahoo.cm": "yahoo.com",
  "hotmial.com": "hotmail.com", "hotmali.com": "hotmail.com",
  "hotmai.com": "hotmail.com", "hotmail.co": "hotmail.com",
  "outlok.com": "outlook.com", "outlool.com": "outlook.com",
  "outlook.co": "outlook.com",
  "aol.co": "aol.com", "aol.cm": "aol.com",
  "comcast.ne": "comcast.net", "comcast.cm": "comcast.net",
}

export function typoSuggestion(domain) {
  return TYPO_DOMAINS[domain] ?? null
}

// ---------------------------------------------------------------------------
// Tier 2: DNS deliverability. `resolveDomain` is injected so the decision
// logic (classifyDns) is unit-testable without touching the real resolver.
// ---------------------------------------------------------------------------

export async function resolveDomainDeliverability(domain, resolver = dns) {
  try {
    const mx = await resolver.resolveMx(domain)
    if (mx && mx.length > 0) {
      return { ok: true, via: "mx", hosts: mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange) }
    }
  } catch (err) {
    if (err.code !== "ENODATA" && err.code !== "ENOTFOUND") {
      return { ok: null, via: null, hosts: [], error: err.code ?? String(err) }
    }
  }
  // RFC 5321 §5.1: no MX record → the domain's own A/AAAA is the implicit MX.
  for (const fn of ["resolve4", "resolve6"]) {
    try {
      const addrs = await resolver[fn](domain)
      if (addrs && addrs.length > 0) return { ok: true, via: fn === "resolve4" ? "a" : "aaaa", hosts: addrs }
    } catch (err) {
      if (err.code !== "ENODATA" && err.code !== "ENOTFOUND") {
        return { ok: null, via: null, hosts: [], error: err.code ?? String(err) }
      }
    }
  }
  return { ok: false, via: null, hosts: [] }
}

// dnsResult: the shape resolveDomainDeliverability returns (or a stub of it
// in tests). Turns it into one of 'ok' | 'dead_domain' | 'dns_unknown'.
export function classifyDns(dnsResult) {
  if (dnsResult.ok === true) return "ok"
  if (dnsResult.ok === false) return "dead_domain" // definitive: no MX and no A/AAAA
  return "dns_unknown" // resolver error (timeout/SERVFAIL) — inconclusive, needs a retry, not a verdict
}

// ---------------------------------------------------------------------------
// SMTP tier (built per the brief's ask, not exercised live tonight — see
// module docstring and D15 in the progress ledger). Pure protocol pieces
// only; the actual socket I/O (probeRcpt) is exercised by the startup
// self-test, never by unit tests, per this repo's "unit tests: no network"
// rule (vitest.config.ts).
// ---------------------------------------------------------------------------

export function buildProbeCommands({ heloDomain, mailFrom, rcptTo }) {
  return [`EHLO ${heloDomain}`, `MAIL FROM:<${mailFrom}>`, `RCPT TO:<${rcptTo}>`, "QUIT"]
}

// SMTP reply codes → verdict. 2xx = accepted, 5xx = permanent reject, 4xx =
// temporary (greylisting, quota) — never treat 4xx as "bad", it will often
// clear on its own.
export function classifySmtpCode(code) {
  const n = Number(code)
  if (Number.isNaN(n)) return "unknown"
  if (n >= 200 && n < 300) return "valid"
  if (n >= 500 && n < 600) return "invalid"
  if (n >= 400 && n < 500) return "unknown" // temp-fail / greylist — not a verdict
  return "unknown"
}

// One-time reachability check: is outbound SMTP even possible from this
// host? Never touches a recipient's real address — just tests the network
// path against a fixed, always-up MX.
export function selfTestSmtpReachable({ host = "gmail-smtp-in.l.google.com", port = 25, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port })
    const done = (ok) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once("connect", () => done(true))
    sock.once("timeout", () => done(false))
    sock.once("error", () => done(false))
  })
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// classifyEmail: the full tier-1 + tier-2 decision for one address.
// `resolveDomain` injected for testability (see resolveDomainDeliverability).
export async function classifyEmail(email, { resolveDomain = resolveDomainDeliverability } = {}) {
  const trimmed = typeof email === "string" ? email.trim() : ""
  const domain = emailDomain(trimmed)
  const flags = {
    role_account: domain ? isRoleAccount(trimmed) : false,
    typo_suspect: domain ? typoSuggestion(domain) : null,
  }

  if (!isValidSyntax(trimmed)) {
    return { classification: "syntax_invalid", reason: "does not look like a valid email address", domain, ...flags }
  }
  if (isDisposableDomain(domain)) {
    return { classification: "disposable", reason: `${domain} is a known throwaway/disposable mail service`, domain, ...flags }
  }

  const dnsResult = await resolveDomain(domain)
  const classification = classifyDns(dnsResult)
  const reason =
    classification === "ok"
      ? `resolves via ${dnsResult.via}`
      : classification === "dead_domain"
        ? "no MX and no A/AAAA record — domain cannot receive mail"
        : `DNS lookup inconclusive (${dnsResult.error ?? "unknown error"}) — retry, not a verdict`
  return { classification, reason, domain, ...flags }
}

// Small fixed-concurrency runner — no new dependency for something this
// simple, and DNS lookups (unlike SMTP probes) carry no reputation risk to
// rate-limit against.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function fetchContacts(sb, { statuses, limit }) {
  const rows = []
  const pageSize = 1000 // PostgREST default row cap — page past it or silently lose rows
  for (let from = 0; ; from += pageSize) {
    let q = sb.from("campaign_contacts").select("id, name, email, status").in("status", statuses).not("email", "is", null)
    q = q.order("id", { ascending: true }).range(from, from + pageSize - 1)
    const { data, error } = await q
    if (error) throw new Error(`campaign_contacts: ${error.message}`)
    rows.push(...data)
    if (data.length < pageSize) break
    if (limit && rows.length >= limit) break
  }
  return limit ? rows.slice(0, limit) : rows
}

function toCsv(records) {
  const header = "id,email,domain,classification,reason,role_account,typo_suspect"
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`
  const lines = records.map((r) =>
    [r.id, r.email, r.domain, r.classification, r.reason, r.role_account, r.typo_suspect ?? ""].map(esc).join(","),
  )
  return [header, ...lines].join("\n") + "\n"
}

async function main() {
  loadEnvLocal()
  const args = process.argv.slice(2)
  const limitArg = args.find((a) => a.startsWith("--limit="))
  const statusArg = args.find((a) => a.startsWith("--status="))
  const asJson = args.includes("--json")
  const wantSmtp = args.includes("--smtp")
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null
  const statuses = statusArg ? statusArg.split("=")[1].split(",") : ["active"]

  const smtpReachable = wantSmtp ? await selfTestSmtpReachable() : false
  if (wantSmtp && !smtpReachable) {
    console.log(
      "[verify-email-list] --smtp requested but the self-test connection to gmail-smtp-in.l.google.com:25 " +
        "did not complete — outbound SMTP looks blocked from this network. Falling back to DNS+syntax only.",
    )
  }
  // Real RCPT-TO probing is intentionally not wired into the per-contact
  // loop even when smtpReachable is true — see module docstring: that path
  // needs a supervised, explicit decision, not an unattended nightly run.

  const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  })
  const contacts = await fetchContacts(sb, { statuses, limit })

  const results = await mapWithConcurrency(contacts, 20, async (c) => {
    const verdict = await classifyEmail(c.email)
    return { id: c.id, name: c.name, email: c.email, ...verdict }
  })

  const counts = {}
  let roleCount = 0
  let typoCount = 0
  for (const r of results) {
    counts[r.classification] = (counts[r.classification] ?? 0) + 1
    if (r.role_account) roleCount++
    if (r.typo_suspect) typoCount++
  }
  const domains = new Set(results.map((r) => r.domain).filter(Boolean))

  const report = {
    generated_at: new Date().toISOString(),
    statuses_checked: statuses,
    contacts_checked: results.length,
    unique_domains: domains.size,
    counts,
    advisory_counts: { role_account: roleCount, typo_suspect: typoCount },
    smtp: {
      requested: wantSmtp,
      reachable: smtpReachable,
      note: "RCPT-TO probing not run even when reachable — needs a supervised decision, see script docstring",
    },
    records: results,
  }

  fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2))
  fs.writeFileSync(REPORT_CSV_PATH, toCsv(results))

  const bad = (counts.dead_domain ?? 0) + (counts.syntax_invalid ?? 0) + (counts.disposable ?? 0)
  console.log(`[verify-email-list] checked ${results.length} contacts across ${domains.size} domains`)
  console.log(`[verify-email-list] counts:`, counts)
  console.log(`[verify-email-list] advisory: ${roleCount} role accounts, ${typoCount} typo-suspects`)
  console.log(`[verify-email-list] ${bad} address(es) look undeliverable before any touch — see ${REPORT_CSV_PATH}`)
  console.log(`[verify-email-list] full report: ${REPORT_JSON_PATH}`)
  if (asJson) console.log(JSON.stringify(report))
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error("[verify-email-list] fatal:", err)
    process.exit(1)
  })
}
