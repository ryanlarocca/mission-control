import { describe, it, expect } from "vitest"
import * as verifyModule from "../scripts/campaign-verify.mjs"
import { verifyAction as tsVerifyAction, isDraftEligible as tsIsDraftEligible, mapVerifier as tsMapVerifier } from "../lib/verify"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { mapVerifier, verifyAction, isDraftEligible, unknownTwice, selectVerifyCandidates, verifyEmail, verifyMany, summarizeVerification, summaryLine, isSandboxKey, classifyVendorError, VerifierAuthError, VERIFIER_URL } = verifyModule as unknown as Record<string, any>

const now = new Date("2026-10-15T15:00:00Z")
// MillionVerifier's documented (and live-confirmed, 2026-10-15) single-verify
// response shape. HTTP 200 even on failures: `error` is "" on success.
const mv = (over: Record<string, unknown> = {}) => ({
  email: "agent@kw.com", quality: "good", result: "ok", resultcode: 1, subresult: "ok", free: false, role: false,
  didyoumean: "", credits: 500, executiontime: 1121, error: "", livemode: true, ...over,
})

describe("Task 5 — verifier mapping (MillionVerifier documented response shape, never live)", () => {
  it("maps ok / catch_all / invalid / disposable / unknown onto the vendor-neutral vocabulary", () => {
    expect(mapVerifier(mv(), now)).toMatchObject({ result: "deliverable", reason: "ok", accept_all: false, sendex: null, checked_at: now.toISOString(), domain: "kw.com", balance: 500, did_you_mean: null })
    expect(mapVerifier(mv({ quality: "risky", result: "catch_all", resultcode: 2, subresult: "ok" }), now)).toMatchObject({ result: "risky", accept_all: true, reason: "ok" })
    expect(mapVerifier(mv({ quality: "bad", result: "invalid", resultcode: 6, subresult: "mailbox_not_found" }), now)).toMatchObject({ result: "undeliverable", reason: "mailbox_not_found", accept_all: false })
    expect(mapVerifier(mv({ quality: "bad", result: "disposable", resultcode: 5, subresult: "" }), now)).toMatchObject({ result: "undeliverable", reason: "disposable", disposable: true })
    expect(mapVerifier(mv({ quality: "risky", result: "unknown", resultcode: 4, subresult: "timeout" }), now)).toMatchObject({ result: "unknown", reason: "timeout" })
    expect(mapVerifier(mv({ result: "OK", subresult: "" }), now)).toMatchObject({ result: "deliverable", reason: "ok" }) // case-insensitive, reason falls back to the vendor result
    expect(mapVerifier(mv({ didyoumean: "agent@kw.com" }), now).did_you_mean).toBe("agent@kw.com")
    expect(tsMapVerifier(mv(), now).result).toBe("deliverable")
  })
  it("a non-empty `error`, an off-shape body, or a missing result is unknown — a bad day at the vendor never suppresses anyone", () => {
    expect(mapVerifier(mv({ result: "ok", error: "something odd" }), now)).toMatchObject({ result: "unknown", reason: "api_error:something odd", accept_all: false })
    expect(mapVerifier(mv({ result: "catch_all", error: "temporary failure" }), now).accept_all).toBe(false)
    expect(mapVerifier(null, now)).toMatchObject({ result: "unknown", reason: "bad_response", accept_all: false, sendex: null, balance: null })
    expect(mapVerifier({ result: "weird" }, now)).toMatchObject({ result: "unknown", reason: "bad_response" })
    expect(mapVerifier({}, now)).toMatchObject({ result: "unknown", reason: "bad_response", domain: null })
  })
  it("verdict → action: deliverable eligible; accept_all eligible as catch-all; risky eligible; unknown hold; undeliverable suppress as 'invalid'", () => {
    expect(verifyAction({ result: "deliverable", accept_all: false })).toEqual({ action: "eligible", bucket: "deliverable" })
    expect(verifyAction({ result: "deliverable", accept_all: true })).toEqual({ action: "eligible", bucket: "catch_all" })
    expect(verifyAction({ result: "risky", accept_all: true })).toEqual({ action: "eligible", bucket: "catch_all" })
    expect(verifyAction({ result: "risky", accept_all: false })).toEqual({ action: "eligible", bucket: "risky" })
    expect(verifyAction({ result: "unknown", accept_all: false })).toEqual({ action: "hold", bucket: "unknown" })
    expect(verifyAction({ result: "undeliverable", accept_all: false })).toEqual({ action: "suppress", bucket: "undeliverable", source: "verify_undeliverable", status: "invalid" })
    // the vendor's catch_all goes through the mapping as risky + accept_all → still eligible, counted as catch-all
    expect(verifyAction(mapVerifier(mv({ result: "catch_all" }), now))).toEqual({ action: "eligible", bucket: "catch_all" })
    expect(verifyAction(mapVerifier(mv({ result: "disposable" }), now)).bucket).toBe("undeliverable")
    expect(tsVerifyAction({ result: "deliverable", accept_all: true }).bucket).toBe("catch_all")
  })
  it("test keys are recognised; key / credit error strings classify as 401 / 403", () => {
    expect(isSandboxKey("API_KEY_FOR_TEST")).toBe(true)
    expect(isSandboxKey("API_KEY_FOR_OK")).toBe(true)
    expect(isSandboxKey("API_KEY_FOR_DISPOSABLE")).toBe(true)
    expect(isSandboxKey("MV12345abcdef")).toBe(false)
    expect(isSandboxKey("test_abc123")).toBe(false)
    expect(isSandboxKey(undefined)).toBe(false)
    expect(classifyVendorError("api key is not valid")).toBe(401)
    expect(classifyVendorError("Invalid key")).toBe(401)
    expect(classifyVendorError("insufficient credits")).toBe(403)
    expect(classifyVendorError("Not enough balance")).toBe(403)
    expect(classifyVendorError("something odd")).toBeNull()
    expect(classifyVendorError("")).toBeNull()
    expect(classifyVendorError(undefined)).toBeNull()
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
    expect(isDraftEligible({ verified_at: fresh, verify_result: "risky", verify_accept_all: true }, { required: true, now })).toMatchObject({ eligible: true, bucket: "catch_all" })
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
    // a vendor outage on either side is not a verdict on the mailbox
    expect(unknownTwice(first, { result: "unknown", reason: "http_503" }, now)).toBe(false)
    expect(unknownTwice(first, { result: "unknown", reason: "fetch_error" }, now)).toBe(false)
    expect(unknownTwice({ ...first, verify_reason: "api_error:timeout" }, { result: "unknown", reason: "greylisted" }, now)).toBe(false)
    expect(unknownTwice({ ...first, verify_reason: "greylisted" }, { result: "unknown", reason: "unknown" }, now)).toBe(true)
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

describe("Task 5 — verifier client (fake fetch)", () => {
  const response = (status: number, body: unknown) => ({
    status,
    headers: { get: () => null },
    json: async () => body,
  })
  it("calls the documented endpoint (trailing slash, api + email + timeout in seconds) and maps the body", async () => {
    const calls: string[] = []
    const fetchImpl = async (url: string) => { calls.push(url); return response(200, mv({ credits: 97 })) }
    const v = await verifyEmail("agent@kw.com", { apiKey: "API_KEY_FOR_OK", fetchImpl })
    expect(VERIFIER_URL).toBe("https://api.millionverifier.com/api/v3/")
    expect(calls[0]).toBe("https://api.millionverifier.com/api/v3/?api=API_KEY_FOR_OK&email=agent%40kw.com&timeout=10")
    expect(v).toMatchObject({ result: "deliverable", balance: 97 })
  })
  it("backs off on 429 and gives up to unknown; HTTP 401/403 abort with VerifierAuthError", async () => {
    const waits: number[] = []
    let n = 0
    const flaky = async () => (n++ < 2 ? response(429, {}) : response(200, mv({ quality: "risky", result: "catch_all", subresult: "ok" })))
    const v = await verifyEmail("a@b.com", { apiKey: "k", fetchImpl: flaky, sleep: async (ms: number) => { waits.push(ms) } })
    expect(v).toMatchObject({ result: "risky", accept_all: true })
    expect(waits).toEqual([1000, 2000])
    const always429 = async () => response(429, {})
    const gaveUp = await verifyEmail("a@b.com", { apiKey: "k", fetchImpl: always429, sleep: async () => {}, maxRetries: 2 })
    expect(gaveUp).toMatchObject({ result: "unknown", reason: "http_429" })
    await expect(verifyEmail("a@b.com", { apiKey: "bad", fetchImpl: async () => response(401, { error: "api key is not valid" }) })).rejects.toBeInstanceOf(VerifierAuthError)
    await expect(verifyEmail("a@b.com", { apiKey: "k", fetchImpl: async () => response(403, { error: "insufficient credits" }) })).rejects.toThrow(/insufficient credits/)
    await expect(verifyEmail("a@b.com", { apiKey: "" })).rejects.toThrow(/MILLIONVERIFIER_API_KEY/)
    const down = await verifyEmail("a@b.com", { apiKey: "k", fetchImpl: async () => { throw new Error("ECONNRESET") } })
    expect(down).toMatchObject({ result: "unknown", reason: "fetch_error" })
    const five = await verifyEmail("a@b.com", { apiKey: "k", fetchImpl: async () => response(500, {}) })
    expect(five).toMatchObject({ result: "unknown", reason: "http_500" })
  })
  it("the vendor's HTTP-200 error strings: key problems abort as 401, missing credits as 403, anything else is unknown", async () => {
    let err: unknown
    try { await verifyEmail("a@b.com", { apiKey: "k", fetchImpl: async () => response(200, mv({ result: "", error: "api key is not valid" })) }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(VerifierAuthError)
    expect((err as { status: number }).status).toBe(401)
    try { await verifyEmail("a@b.com", { apiKey: "k", fetchImpl: async () => response(200, mv({ result: "", error: "insufficient credits" })) }) } catch (e) { err = e }
    expect((err as { status: number }).status).toBe(403)
    const odd = await verifyEmail("a@b.com", { apiKey: "k", fetchImpl: async () => response(200, mv({ error: "temporary failure" })) })
    expect(odd).toMatchObject({ result: "unknown", reason: "api_error:temporary failure" })
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
      const domain = email.split("@")[1]
      return response(200, mv({ email, result: email.startsWith("bad") ? "invalid" : domain === "catch.com" ? "catch_all" : "ok", subresult: email.startsWith("bad") ? "mailbox_not_found" : "ok" }))
    }
    const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), email: `${i === 3 ? "bad" : "ok"}${i}@${i % 2 ? "catch.com" : "kw.com"}` }))
    const seen: string[] = []
    const results = await verifyMany(items, { fetchImpl, apiKey: "k", onResult: async (c: { id: string }) => { seen.push(c.id) } })
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
  it("verifyMany aborts the batch on an auth error, from an HTTP status or from the vendor's error string", async () => {
    await expect(verifyMany([{ email: "a@b.com" }, { email: "c@d.com" }], { fetchImpl: async () => response(403, { error: "insufficient credits" }), apiKey: "k" })).rejects.toBeInstanceOf(VerifierAuthError)
    let err: unknown
    try { await verifyMany([{ email: "a@b.com" }, { email: "c@d.com" }], { fetchImpl: async () => response(200, mv({ error: "insufficient credits" })), apiKey: "k" }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(VerifierAuthError)
    expect((err as { status: number }).status).toBe(403)
    try { await verifyMany([{ email: "a@b.com" }], { fetchImpl: async () => response(200, mv({ error: "api key is not valid" })), apiKey: "k" }) } catch (e) { err = e }
    expect((err as { status: number }).status).toBe(401)
  })
})
