// Free DNS backstop at send time (autopilot brief 2026-10-15, Task 4).
//
// Before each send the engine resolves MX (falling back to A/AAAA, RFC 5321
// §5.1) for the recipient's domain. No MX and no A → the row fails with
// error "no_mx", the contact is suppressed (source "dns_no_mx") and the daily
// card counts it. DNS latency never blocks a send: anything slower than
// `timeoutMs` (2 s) or any resolver error other than "does not exist" is
// treated as a PASS — this is a backstop for dead domains, not a verifier
// (Kickbox is, scripts/campaign-verify.mjs). Results are cached per domain
// per PT day in scripts/.campaign-dns-cache.json (gitignored).
//
// `resolver` is injected so the decision logic is unit-tested without the
// network (tests/campaign-dns.unit.test.ts).

import fs from "node:fs"
import path from "node:path"
import dns from "node:dns/promises"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DNS_CACHE_PATH = path.join(__dirname, ".campaign-dns-cache.json")
export const DNS_TIMEOUT_MS = 2000

const NXDOMAIN = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"])

export function emailDomain(email) {
  const at = String(email ?? "").lastIndexOf("@")
  return at < 0 ? null : String(email).slice(at + 1).trim().toLowerCase() || null
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("dns timeout"), { code: "ETIMEOUT" })), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * "ok" (MX, or A/AAAA fallback, exists) · "no_mx" (definitively nothing) ·
 * "unknown" (timeout / SERVFAIL / resolver error — treated as a pass).
 */
export async function mxStatus(domain, { resolver = dns, timeoutMs = DNS_TIMEOUT_MS } = {}) {
  if (!domain) return "no_mx"
  const lookup = async () => {
    try {
      const mx = await resolver.resolveMx(domain)
      if (mx?.length) return "ok"
    } catch (e) {
      if (!NXDOMAIN.has(e?.code)) return "unknown"
    }
    for (const fn of ["resolve4", "resolve6"]) {
      try {
        const a = await resolver[fn](domain)
        if (a?.length) return "ok"
      } catch (e) {
        if (!NXDOMAIN.has(e?.code)) return "unknown"
      }
    }
    return "no_mx"
  }
  try {
    return await withTimeout(lookup(), timeoutMs)
  } catch {
    return "unknown"
  }
}

/** Only a definitive "no_mx" blocks; "unknown" (latency, resolver trouble) passes. */
export function dnsBlocks(status) {
  return status === "no_mx"
}

/** Per-domain, per-day cache: { day, domains: { [domain]: "ok"|"no_mx" } }. "unknown" is never cached (retry next send). */
export function readDnsCache(day, file = DNS_CACHE_PATH) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf-8"))
    if (c?.day === day && c.domains && typeof c.domains === "object") return c
  } catch { /* first run / stale */ }
  return { day, domains: {} }
}

export function writeDnsCache(cache, file = DNS_CACHE_PATH) {
  try { fs.writeFileSync(file, JSON.stringify(cache)) } catch { /* cache is best-effort */ }
}

/**
 * The send-time gate: cached per domain per day. Returns the status and
 * whether the lookup hit the cache. `cache` is mutated (and persisted when
 * `persist` is true) so one pass resolves each domain at most once.
 */
export async function checkRecipientDomain(email, { cache, resolver = dns, timeoutMs = DNS_TIMEOUT_MS, persist = true, file = DNS_CACHE_PATH } = {}) {
  const domain = emailDomain(email)
  if (!domain) return { domain: null, status: "no_mx", cached: false }
  if (cache?.domains && cache.domains[domain]) return { domain, status: cache.domains[domain], cached: true }
  const status = await mxStatus(domain, { resolver, timeoutMs })
  if (cache?.domains && status !== "unknown") {
    cache.domains[domain] = status
    if (persist) writeDnsCache(cache, file)
  }
  return { domain, status, cached: false }
}
