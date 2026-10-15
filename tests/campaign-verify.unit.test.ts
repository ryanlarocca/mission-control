import { describe, it, expect } from "vitest"
import * as verifyModule from "../scripts/campaign-verify.mjs"
import { verifyAction as tsVerifyAction, isDraftEligible as tsIsDraftEligible, mapKickbox as tsMapKickbox } from "../lib/verify"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { mapKickbox, verifyAction, isDraftEligible, unknownTwice, selectVerifyCandidates, verifyEmail, verifyMany, summarizeVerification, summaryLine, isSandboxKey, KickboxAuthError } = verifyModule as unknown as Record<string, any>

const now = new Date("2026-10-15T15:00:00Z")
// Kickbox's documented single-verify response shape.
const kb = (over: Record<string, unknown> = {}) => ({
  result: "deliverable", reason: "accepted_email", role: false, free: false, disposable: false, accept_all: false,
  did_you_mean: null, sendex: 0.92, email: "agent@kw.com", user: "agent", domain: "kw.com", success: true, message: null, ...over,
})

describe("Task 5 — Kickbox mapping (documented response shape, never live)", () => {
  it("maps the four results and carries reason / accept_all / sendex", () => {
    expect(mapKickbox(kb(), now)).toMatchObject({ result: "deliverable", reason: "accepted_email", accept_all: false, sendex: 0.92, checked_at: now.toISOString(), domain: "kw.com" })
    expect(mapKickbox(kb({ result: "undeliverable", reason: "rejected_email", sendex: 0 }), now)).toMatchObject({ result: "undeliverable", reason: "rejected_email" })
    expect(mapKickbox(kb({ result: "risky", reason: "low_quality", accept_all: true }), now)).toMatchObject({ result: "risky", reason: "low_quality", accept_all: true })
    expect(mapKickbox(kb({ result: "unknown", reason: "timeout" }), now)).toMatchObject({ result: "unknown", reason: "timeout" })
    expect(tsMapKickbox(kb(), now).result).toBe("deliverable")
  })
  it("off-shape or failed responses are unknown — a bad day at Kickbox never suppresses anyone", () => {
    expect(mapKickbox({ success: false, message: "Insufficient balance" }, now)).toMatchObject({ result: "unknown", reason: "api_error:Insufficient balance" })
    expect(mapKickbox(null, now)).toMatchObject({ result: "unknown", reason: "bad_response", accept_all: false, sendex: null })
    expect(mapKickbox({ result: "weird" }, now).result).toBe("unknown")
  })
  it("verdict → action: deliverable eligible; accept_all eligible as catch-all; risky eligible; unknown hold; undeliverable suppress as 'invalid'", () => {
    expect(verifyAction({ result: "deliverable", accept_all: false })).toEqual({ action: "eligible", bucket: "deliverable" })
    expect(verifyAction({ result: "deliverable", accept_all: true })).toEqual({ action: "eligible", bucket: "catch_all" })
    expect(verifyAction({ result: "risky", accept_all: true })).toEqual({ action: "eligible", bucket: "catch_all" })
    expect(verifyAction({ result: "risky", accept_all: false })).toEqual({ action: "eligible", bucket: "risky" })
    expect(verifyAction({ result: "unknown", accept_all: false })).toEqual({ action: "hold", bucket: "unknown" })
    expect(verifyAction({ result: "undeliverable", accept_all: false })).toEqual({ action: "suppress", bucket: "undeliverable", source: "verify_undeliverable", status: "invalid" })
    expect(tsVerifyAction({ result: "deliverable", accept_all: true }).bucket).toBe("catch_all")
  })
  it("sandbox keys are recognised", () => {
    expect(isSandboxKey("test_abc123")).toBe(true)
    expect(isSandboxKey("live_abc123")).toBe(false)
    expect(isSandboxKey(undefined)).toBe(false)
  })
})

describe("Task 5 — the send rule (verify_required gate)", () => {
  const fresh = new Date(now.getTime() - 3 * 86_400_000).toISOString()
  const stale = new Date(now.getTime() - 31 * 86_400_000).toISOString()
  it("is disabled until Ryan flips verify_required", () => {
    expect(isDraftEligible({ verified_at: null }, { required: false, now })).toMatchObject({ eligible: true, why: "verify_required off" })
    expect(isDraftEligible({ verified_at: fresh, verify_result: "undeliverable" }, { required: false, now }).eligible).toBe(true)
  })
  it("when required: fresh + eligible result only; catch-all is never filtered", () => {
    expect(isDraftEligible({ verified_at: fresh, verify_result: "deliverable", verify_accept_all: false }, { required: true, now })).toMatchObject({ eligible: true, bucket: "deliverable" })
    expect(isDraftEligible({ verified_at: fresh, verify_result: "deliverable", verify_accept_all: true }, { required: true, now })).toMatchObject({ eligible: true, bucket: "catch_all" })
    expect(isDraftEligible({ verified_at: fresh, verify_result: "risky", verify_accept_all: false }, { required: true, now })).toMatchObject({ eligible: true, bucket: "risky" })
    expect(isDraftEligible({ verified_at: fresh, verify_result: "unknown" }, { required: true, now })).toMatchObject({ eligible: false, bucket: "unknown" })
    expect(isDraftEligible({ verified_at: fresh, verify_result: "undeliverable" }, { required: true, now })).toMatchObject({ eligible: false, bucket: "undeliverable" })
    expect(isDraftEligible({ verified_at: null }, { required: true, now })).toMatchObject({ eligible: false, why: "unverified" })
    expect(isDraftEligible({ verified_at: stale, verify_result: "deliverable" }, { required: true, now })).toMatchObject({ eligible: false, bucket: "stale" })
    expect(tsIsDraftEligible({ verified_at: fresh, verify_result: "deliverable" }, { required: true, now }).eligible).toBe(true)
  })
  it("a second 'unknown' seven days after the first is the suppress signal", () => {
    const first = { verify_result: "unknown", verified_at: new Date(now.getTime() - 8 * 86_400_000).toISOString() }
    expect(unknownTwice(first, { result: "unknown" }, now)).toBe(true)
    expect(unknownTwice({ ...first, verified_at: new Date(now.getTime() - 2 * 86_400_000).toISOString() }, { result: "unknown" }, now)).toBe(false)
    expect(unknownTwice(first, { result: "deliverable" }, now)).toBe(false)
    expect(unknownTwice({ verify_result: null, verified_at: null }, { result: "unknown" }, now)).toBe(false)
  })
  it("picks the morning pass candidates: due within 7 days and never / stale / unknown-7d verified, skipping suppressed", () => {
    const d = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString()
    const contacts = [
      { id: "a", status: "active", email: "a@x.com", next_touch_at: d(-30), verified_at: null },
      { id: "b", status: "active", email: "b@x.com", next_touch_at: d(3), verified_at: fresh, verify_result: "deliverable" },
      { id: "c", status: "active", email: "c@x.com", next_touch_at: d(3), verified_at: stale, verify_result: "deliverable" },
      { id: "d", status: "active", email: "d@x.com", next_touch_at: d(3), verified_at: new Date(now.getTime() - 8 * 86_400_000).toISOString(), verify_result: "unknown" },
      { id: "e", status: "active", email: "e@x.com", next_touch_at: d(20), verified_at: null },
      { id: "f", status: "bounced", email: "f@x.com", next_touch_at: d(1), verified_at: null },
      { id: "g", status: "active", email: "Supp@x.com", next_touch_at: d(1), verified_at: null },
      { id: "h", status: "active", email: null, next_touch_at: d(1), verified_at: null },
    ]
    const picked = selectVerifyCandidates(contacts, { now, suppressedEmails: new Set(["supp@x.com"]) })
    expect(picked.map((c: { id: string }) => c.id)).toEqual(["a", "c", "d"])
    // the one-time first pass drops the due filter but still skips fresh verdicts
    // (soonest due first; g is due tomorrow, c/d in three days, e in twenty)
    expect(selectVerifyCandidates(contacts, { now, all: true }).map((c: { id: string }) => c.id)).toEqual(["a", "g", "c", "d", "e"])
  })
})

describe("Task 5 — Kickbox client (fake fetch)", () => {
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  })
  it("calls the documented endpoint with email, apikey and timeout and maps the body", async () => {
    const calls: string[] = []
    const fetchImpl = async (url: string) => { calls.push(url); return response(200, kb(), { "x-kickbox-balance": "97" }) }
    const v = await verifyEmail("agent@kw.com", { apiKey: "test_key", fetchImpl })
    expect(calls[0]).toBe("https://api.kickbox.com/v2/verify?email=agent%40kw.com&apikey=test_key&timeout=10000")
    expect(v).toMatchObject({ result: "deliverable", balance: 97 })
  })
  it("backs off on 429 and gives up to unknown; 401/403 abort with KickboxAuthError", async () => {
    const waits: number[] = []
    let n = 0
    const flaky = async () => (n++ < 2 ? response(429, {}) : response(200, kb({ result: "risky", reason: "low_deliverability" })))
    const v = await verifyEmail("a@b.com", { apiKey: "test_k", fetchImpl: flaky, sleep: async (ms: number) => { waits.push(ms) } })
    expect(v.result).toBe("risky")
    expect(waits).toEqual([1000, 2000])
    const always429 = async () => response(429, {})
    const gaveUp = await verifyEmail("a@b.com", { apiKey: "test_k", fetchImpl: always429, sleep: async () => {}, maxRetries: 2 })
    expect(gaveUp).toMatchObject({ result: "unknown", reason: "http_429" })
    await expect(verifyEmail("a@b.com", { apiKey: "bad", fetchImpl: async () => response(401, { success: false, message: "Invalid API key" }) })).rejects.toBeInstanceOf(KickboxAuthError)
    await expect(verifyEmail("a@b.com", { apiKey: "k", fetchImpl: async () => response(403, { success: false, message: "Insufficient balance" }) })).rejects.toThrow(/Insufficient balance/)
    await expect(verifyEmail("a@b.com", { apiKey: "" })).rejects.toThrow(/KICKBOX_API_KEY/)
    const down = await verifyEmail("a@b.com", { apiKey: "k", fetchImpl: async () => { throw new Error("ECONNRESET") } })
    expect(down).toMatchObject({ result: "unknown", reason: "fetch_error" })
    const five = await verifyEmail("a@b.com", { apiKey: "k", fetchImpl: async () => response(500, {}) })
    expect(five).toMatchObject({ result: "unknown", reason: "http_500" })
  })
  it("verifyMany keeps ≤ 5 in flight, returns results in order and fires onResult per item", async () => {
    let inFlight = 0
    let peak = 0
    const fetchImpl = async (url: string) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      const email = decodeURIComponent(/email=([^&]+)/.exec(url)![1])
      return response(200, kb({ email, domain: email.split("@")[1], result: email.startsWith("bad") ? "undeliverable" : "deliverable", accept_all: email.endsWith("catch.com") }))
    }
    const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), email: `${i === 3 ? "bad" : "ok"}${i}@${i % 2 ? "catch.com" : "kw.com"}` }))
    const seen: string[] = []
    const results = await verifyMany(items, { fetchImpl, apiKey: "test_k", onResult: async (c: { id: string }) => { seen.push(c.id) } })
    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBeGreaterThan(1)
    expect(results).toHaveLength(12)
    expect(results[3].result).toBe("undeliverable")
    expect(seen.sort((a, b) => Number(a) - Number(b))).toEqual(items.map((c) => c.id))
    const summary = summarizeVerification(items.map((c, i) => ({ email: c.email, verdict: results[i] })))
    // item 3 (bad3@catch.com) is undeliverable, so the catch-all domain counts 5, not 6
    expect(summary).toEqual({ total: 12, counts: { deliverable: 6, catch_all: 5, risky: 0, unknown: 0, undeliverable: 1 }, topCatchAll: [{ domain: "catch.com", n: 5 }] })
    expect(summaryLine(summary)).toBe("verified 12: 6 deliverable (50.0%) · 5 catch-all (41.7%) · 0 risky (0.0%) · 0 unknown (0.0%) · 1 undeliverable (8.3%)\nTop catch-all domains: catch.com (5)")
  })
  it("verifyMany aborts the batch on an auth error", async () => {
    const fetchImpl = async () => response(403, { success: false, message: "Insufficient balance" })
    await expect(verifyMany([{ email: "a@b.com" }, { email: "c@d.com" }], { fetchImpl, apiKey: "k" })).rejects.toBeInstanceOf(KickboxAuthError)
  })
})
