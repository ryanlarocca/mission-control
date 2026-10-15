// List verification via MillionVerifier (autopilot brief 2026-10-15, Task 5;
// vendor changed from Kickbox the same day — Kickbox refused the account
// under its Acceptable Use Policy, a directory-sourced B2B list is not
// "opt-in" to them; MillionVerifier's terms permit lawfully used third-party
// and public data).
//
// "Nothing fancy on the verifier: cheapest tool that answers 'does this
// mailbox exist'." One GET per address against the single-verify endpoint,
// ≤ 5 in flight, 429s backed off. The list is 2–3k addresses, so a bulk
// endpoint is not worth its plumbing.
//
// This module is the canonical implementation for BOTH the engine
// (scripts/campaign-engine.mjs verifyPass / --verify-all / --verify-domains)
// and the Next.js side (lib/verify.ts re-exports it with types). Everything
// that decides something is pure and unit-tested against the vendor's
// documented response shape (tests/campaign-verify.unit.test.ts) — never
// against the live API. Test keys (`API_KEY_FOR_OK`, `API_KEY_FOR_INVALID`,
// `API_KEY_FOR_DISPOSABLE`, …) return canned results and consume no credits.
//
// The INTERNAL vocabulary is vendor-neutral and unchanged from the brief:
// result ∈ deliverable | undeliverable | risky | unknown, plus accept_all.
// MillionVerifier's `result` maps onto it:
//   ok          → deliverable, accept_all false
//   catch_all   → risky, accept_all true            (bucket catch_all — still NEVER filtered)
//   invalid     → undeliverable
//   disposable  → undeliverable (reason "disposable" — a brokerage list has no legitimate throwaways)
//   unknown     → unknown
//   `error` set / off-shape / non-200 / fetch error → unknown (never suppresses on a bad day)
//
// Mapping → engine action (brief, Task 5):
//   deliverable                         → eligible
//   deliverable/risky + accept_all      → eligible, counted as "catch-all" on the card (NEVER filtered —
//                                         catch-all is a property of the domain, not the agent)
//   risky (no accept_all)               → eligible (reason logged)
//   unknown                             → hold out of the queue; re-verify after 7 days; still unknown → suppress "verify_unknown"
//   undeliverable                       → suppress "verify_undeliverable", contact status "invalid" (NOT "bounced")

// Trailing slash is required: without it Cloudflare answers 301 to the slashed path.
export const VERIFIER_URL = "https://api.millionverifier.com/api/v3/"
export const VERIFIER_TIMEOUT_S = 10 // the `timeout` query param, in SECONDS (2–60; vendor default 20)
export const VERIFIER_ENV = "MILLIONVERIFIER_API_KEY"
export const VERIFY_FRESH_DAYS = 30 // a verdict older than this is stale for the draft rule
export const VERIFY_UNKNOWN_RETRY_DAYS = 7 // re-verify an "unknown" after this many days
export const VERIFY_HORIZON_DAYS = 7 // the morning pass verifies whatever is due within this window
export const VERIFY_DAILY_MAX_DEFAULT = 500
export const VERIFY_CONCURRENCY = 5
export const VERIFY_RESULTS = ["deliverable", "undeliverable", "risky", "unknown"]
const VENDOR_RESULT = { ok: "deliverable", catch_all: "risky", invalid: "undeliverable", disposable: "undeliverable", unknown: "unknown" }
const AUTH_ERROR_RE = /api key|invalid key|credit|balance/i

export function isSandboxKey(apiKey) {
  return /^API_KEY_FOR_/.test(String(apiKey ?? ""))
}

export class VerifierAuthError extends Error {
  constructor(status, message) {
    super(`MillionVerifier ${status}: ${message}`)
    this.name = "VerifierAuthError"
    this.status = status
  }
}

/**
 * The vendor returns HTTP 200 even on failures, with `error` set to a
 * message. Key problems read as 401, missing credits as 403 — the engine's
 * Telegram wording branches on the status.
 */
export function classifyVendorError(message) {
  const m = String(message ?? "")
  if (!m) return null
  if (!AUTH_ERROR_RE.test(m)) return null
  return /credit|balance/i.test(m) ? 403 : 401
}

/**
 * MillionVerifier's documented single-verify response
 * { email, result, quality, resultcode, subresult, free, role, didyoumean, credits, executiontime, error, livemode }
 * → { result, reason, accept_all, sendex, checked_at, role, free, disposable, did_you_mean, domain, balance }.
 * `reason` is `subresult` when present, else the vendor result. `sendex`
 * stays in the shape (null — no equivalent). Anything off-shape or with
 * `error` set maps to "unknown" so a bad day at the vendor never suppresses anyone.
 */
export function mapVerifier(json, now = new Date()) {
  const j = json && typeof json === "object" ? json : {}
  const err = typeof j.error === "string" && j.error.trim() ? j.error.trim() : null
  const vendor = typeof j.result === "string" ? j.result.toLowerCase() : null
  const mapped = vendor && !err ? VENDOR_RESULT[vendor] ?? null : null
  const result = mapped ?? "unknown"
  const sub = typeof j.subresult === "string" && j.subresult.trim() ? j.subresult.trim() : null
  const reason = err ? `api_error:${err.slice(0, 60)}` : !vendor || !mapped ? "bad_response" : vendor === "disposable" ? "disposable" : sub ?? vendor
  const email = typeof j.email === "string" ? j.email.trim().toLowerCase() : ""
  const at = email.lastIndexOf("@")
  return {
    result,
    reason,
    accept_all: vendor === "catch_all" && !err,
    sendex: null,
    checked_at: now.toISOString(),
    role: j.role === true,
    free: j.free === true,
    disposable: vendor === "disposable" && !err,
    did_you_mean: typeof j.didyoumean === "string" && j.didyoumean.trim() ? j.didyoumean.trim() : null,
    domain: at > 0 ? email.slice(at + 1) : null,
    balance: typeof j.credits === "number" && Number.isFinite(j.credits) ? j.credits : null,
  }
}

/**
 * What the engine does with a verdict (see the table above).
 * Returns { action: "eligible"|"hold"|"suppress", bucket, source?, status? }.
 */
export function verifyAction(v) {
  const r = v?.result ?? "unknown"
  if (r === "deliverable") return { action: "eligible", bucket: v.accept_all ? "catch_all" : "deliverable" }
  if (r === "risky") return { action: "eligible", bucket: v.accept_all ? "catch_all" : "risky" }
  if (r === "undeliverable") return { action: "suppress", bucket: "undeliverable", source: "verify_undeliverable", status: "invalid" }
  return { action: "hold", bucket: "unknown" }
}

/** Second consecutive "unknown" (the first was ≥ 7 days ago) → suppress "verify_unknown". */
export function unknownTwice(previous, next, now = new Date()) {
  if (next?.result !== "unknown") return false
  if (previous?.verify_result !== "unknown" || !previous?.verified_at) return false
  return ageDays(previous.verified_at, now) >= VERIFY_UNKNOWN_RETRY_DAYS
}

export function ageDays(iso, now = new Date()) {
  const t = new Date(iso ?? NaN).getTime()
  if (!Number.isFinite(t)) return Infinity
  return (now.getTime() - t) / 86_400_000
}

/**
 * The send rule: draft-eligible only when verified within 30 days with an
 * eligible result — gated by campaign_settings `verify_required`. Pure.
 * Returns { eligible, why, bucket }.
 */
export function isDraftEligible(contact, { required = false, now = new Date() } = {}) {
  if (!required) return { eligible: true, why: "verify_required off", bucket: contact?.verify_result === "unknown" ? "unknown" : contact?.verify_accept_all ? "catch_all" : contact?.verify_result ?? "unverified" }
  if (!contact?.verified_at) return { eligible: false, why: "unverified", bucket: "unverified" }
  if (ageDays(contact.verified_at, now) > VERIFY_FRESH_DAYS) return { eligible: false, why: `verified ${Math.floor(ageDays(contact.verified_at, now))} days ago (> ${VERIFY_FRESH_DAYS})`, bucket: "stale" }
  const act = verifyAction({ result: contact.verify_result, accept_all: contact.verify_accept_all === true })
  if (act.action === "eligible") return { eligible: true, why: act.bucket, bucket: act.bucket }
  return { eligible: false, why: act.action === "hold" ? "unknown — awaiting re-verify" : "undeliverable", bucket: act.bucket }
}

/**
 * Which contacts the morning pass verifies (pure filter over active,
 * non-suppressed contacts): due within `horizonDays` AND (never verified, or
 * verified > 30 days ago, or "unknown" ≥ 7 days ago). `all: true` drops the
 * due filter (the one-time --verify-all first pass) but still skips fresh
 * verdicts so a re-run is cheap. Sorted soonest-due first, then stable.
 */
export function selectVerifyCandidates(contacts, { now = new Date(), horizonDays = VERIFY_HORIZON_DAYS, all = false, suppressedEmails = null } = {}) {
  const horizon = now.getTime() + horizonDays * 86_400_000
  const out = []
  for (const c of contacts ?? []) {
    if (!c || c.status !== "active" || !c.email) continue
    const email = String(c.email).trim().toLowerCase()
    if (suppressedEmails?.has?.(email)) continue
    if (!all) {
      const due = c.next_touch_at ? new Date(c.next_touch_at).getTime() : 0
      if (due > horizon) continue
    }
    const age = ageDays(c.verified_at, now)
    const needs = !c.verified_at || age > VERIFY_FRESH_DAYS || (c.verify_result === "unknown" && age >= VERIFY_UNKNOWN_RETRY_DAYS)
    if (!needs) continue
    out.push(c)
  }
  return out.sort((a, b) => String(a.next_touch_at ?? "").localeCompare(String(b.next_touch_at ?? "")))
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One MillionVerifier call. 429 → exponential backoff (1 s, 2 s, 4 s) up to
 * `maxRetries`; a key / credit problem (HTTP 401/403, or the vendor's usual
 * HTTP 200 with `error` naming the key or the credits) → VerifierAuthError
 * (the pass stops rather than burning the queue on a dead key); any other
 * non-200 or a network error → "unknown" with reason `http_<status>` /
 * `fetch_error`.
 */
export async function verifyEmail(email, { apiKey = process.env[VERIFIER_ENV], fetchImpl = globalThis.fetch, timeoutS = VERIFIER_TIMEOUT_S, maxRetries = 3, sleep = defaultSleep, now = () => new Date() } = {}) {
  if (!apiKey) throw new VerifierAuthError(0, `${VERIFIER_ENV} is not set`)
  const url = `${VERIFIER_URL}?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(String(email).trim())}&timeout=${timeoutS}`
  let attempt = 0
  for (;;) {
    let res
    try {
      res = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } })
    } catch (e) {
      return { ...mapVerifier({ error: `fetch: ${e?.message ?? e}` }, now()), reason: "fetch_error" }
    }
    if (res.status === 429 && attempt < maxRetries) {
      await sleep(1000 * 2 ** attempt)
      attempt++
      continue
    }
    if (res.status === 401 || res.status === 403) {
      let msg = ""
      try { msg = (await res.json())?.error ?? "" } catch { /* no body */ }
      throw new VerifierAuthError(res.status, msg || (res.status === 401 ? "invalid API key" : "forbidden / insufficient credits"))
    }
    if (res.status !== 200) return { ...mapVerifier({ error: `http ${res.status}` }, now()), reason: `http_${res.status}` }
    let json = null
    try { json = await res.json() } catch { json = null }
    const authStatus = classifyVendorError(json?.error)
    if (authStatus) throw new VerifierAuthError(authStatus, String(json.error))
    return mapVerifier(json, now())
  }
}

/**
 * Sequential-ish batch: ≤ `concurrency` calls in flight, results in input
 * order. `onResult(item, verdict, index)` fires as each lands (the engine
 * writes the contact there). A VerifierAuthError aborts the whole batch.
 */
export async function verifyMany(items, { concurrency = VERIFY_CONCURRENCY, emailOf = (x) => (typeof x === "string" ? x : x.email), onResult = null, ...opts } = {}) {
  const results = new Array(items.length)
  let next = 0
  let aborted = null
  async function worker() {
    while (next < items.length && !aborted) {
      const i = next++
      try {
        const v = await verifyEmail(emailOf(items[i]), opts)
        results[i] = v
        if (onResult) await onResult(items[i], v, i)
      } catch (e) {
        aborted = e
        throw e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker))
  return results
}

/** Counts per bucket + the top N domains by catch-all for the Telegram summary. */
export function summarizeVerification(rows, { topDomains = 15 } = {}) {
  const counts = { deliverable: 0, catch_all: 0, risky: 0, unknown: 0, undeliverable: 0 }
  const catchAll = new Map()
  for (const r of rows ?? []) {
    if (!r) continue
    const v = r.verdict ?? r
    const b = verifyAction(v).bucket
    counts[b] = (counts[b] ?? 0) + 1
    if (b === "catch_all") {
      const d = v.domain ?? (r.email ? String(r.email).split("@")[1]?.toLowerCase() : null)
      if (d) catchAll.set(d, (catchAll.get(d) ?? 0) + 1)
    }
  }
  const top = [...catchAll.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topDomains).map(([domain, n]) => ({ domain, n }))
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return { total, counts, topCatchAll: top }
}

export function summaryLine({ total, counts, topCatchAll }) {
  const pct = (n) => (total ? ` (${((100 * n) / total).toFixed(1)}%)` : "")
  const line = `verified ${total}: ${counts.deliverable} deliverable${pct(counts.deliverable)} · ${counts.catch_all} catch-all${pct(counts.catch_all)} · ${counts.risky} risky${pct(counts.risky)} · ${counts.unknown} unknown${pct(counts.unknown)} · ${counts.undeliverable} undeliverable${pct(counts.undeliverable)}`
  const top = topCatchAll?.length ? `\nTop catch-all domains: ${topCatchAll.map((d) => `${d.domain} (${d.n})`).join(", ")}` : ""
  return line + top
}
