import { describe, it, expect } from "vitest"
import * as dnsModule from "../scripts/campaign-dns.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { mxStatus, dnsBlocks, checkRecipientDomain, emailDomain, readDnsCache } = dnsModule as unknown as Record<string, any>

const nx = (code = "ENOTFOUND") => Object.assign(new Error(code), { code })
const resolverOf = (impl: Record<string, (d: string) => Promise<unknown>>) => ({
  resolveMx: impl.resolveMx ?? (async () => { throw nx("ENODATA") }),
  resolve4: impl.resolve4 ?? (async () => { throw nx() }),
  resolve6: impl.resolve6 ?? (async () => { throw nx() }),
})

describe("Task 4 — free DNS backstop at send time", () => {
  it("MX present → ok; no MX but an A record → ok (RFC 5321 implicit MX); nothing at all → no_mx", async () => {
    expect(await mxStatus("kw.com", { resolver: resolverOf({ resolveMx: async () => [{ exchange: "mx.kw.com", priority: 10 }] }) })).toBe("ok")
    expect(await mxStatus("tiny-brokerage.com", { resolver: resolverOf({ resolve4: async () => ["203.0.113.5"] }) })).toBe("ok")
    expect(await mxStatus("ipv6-only.example", { resolver: resolverOf({ resolve6: async () => ["2001:db8::1"] }) })).toBe("ok")
    expect(await mxStatus("defunct-brokerage-xyz.com", { resolver: resolverOf({}) })).toBe("no_mx")
    expect(await mxStatus("", {})).toBe("no_mx")
  })

  it("never blocks on DNS latency: a slow or broken resolver is unknown, and unknown passes", async () => {
    const slow = resolverOf({ resolveMx: () => new Promise(() => {}) })
    expect(await mxStatus("slow.example", { resolver: slow, timeoutMs: 20 })).toBe("unknown")
    const servfail = resolverOf({ resolveMx: async () => { throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" }) } })
    expect(await mxStatus("flaky.example", { resolver: servfail })).toBe("unknown")
    expect(dnsBlocks("unknown")).toBe(false)
    expect(dnsBlocks("ok")).toBe(false)
    expect(dnsBlocks("no_mx")).toBe(true)
  })

  it("caches per domain per day (unknown is retried, never cached)", async () => {
    let calls = 0
    const resolver = resolverOf({ resolveMx: async () => { calls++; return [{ exchange: "mx", priority: 1 }] } })
    const cache = { day: "2026-10-15", domains: {} as Record<string, string> }
    const a = await checkRecipientDomain("Agent@KW.com", { cache, resolver, persist: false })
    expect(a).toEqual({ domain: "kw.com", status: "ok", cached: false })
    const b = await checkRecipientDomain("other@kw.com", { cache, resolver, persist: false })
    expect(b).toEqual({ domain: "kw.com", status: "ok", cached: true })
    expect(calls).toBe(1)
    const dead = await checkRecipientDomain("x@gone.example", { cache, resolver: resolverOf({}), persist: false })
    expect(dead.status).toBe("no_mx")
    expect(cache.domains["gone.example"]).toBe("no_mx")
    const slow = await checkRecipientDomain("x@slow.example", { cache, resolver: resolverOf({ resolveMx: () => new Promise(() => {}) }), timeoutMs: 10, persist: false })
    expect(slow.status).toBe("unknown")
    expect(cache.domains["slow.example"]).toBeUndefined()
    expect(await checkRecipientDomain("not-an-email", { cache, resolver, persist: false })).toEqual({ domain: null, status: "no_mx", cached: false })
    expect(emailDomain("Ryan@LRGHomes.com")).toBe("lrghomes.com")
  })

  it("a cache from another day is discarded", () => {
    expect(readDnsCache("2026-10-15", "/nonexistent/.cache.json")).toEqual({ day: "2026-10-15", domains: {} })
  })
})
