import { describe, it, expect } from "vitest"
// Plain ESM module loaded directly (see tests/campaign-senders.unit.test.ts).
import * as verifyModule from "../scripts/verify-email-list.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const {
  isValidSyntax,
  emailDomain,
  isDisposableDomain,
  isRoleAccount,
  typoSuggestion,
  classifyDns,
  classifySmtpCode,
  buildProbeCommands,
  classifyEmail,
} = verifyModule as unknown as Record<string, any>

describe("tier 1: syntax + domain heuristics (pure, no network)", () => {
  it("accepts plausible addresses and rejects malformed ones", () => {
    expect(isValidSyntax("asha@remax.com")).toBe(true)
    expect(isValidSyntax("first.last+tag@sub.domain.co")).toBe(true)
    expect(isValidSyntax("no-at-sign.com")).toBe(false)
    expect(isValidSyntax("two@@domain.com")).toBe(false)
    expect(isValidSyntax("trailing@domain.com ")).toBe(false)
    expect(isValidSyntax("nodot@localhost")).toBe(false)
    expect(isValidSyntax("")).toBe(false)
    expect(isValidSyntax(null)).toBe(false)
    expect(isValidSyntax("a".repeat(250) + "@x.com")).toBe(false)
  })

  it("extracts the lowercased domain", () => {
    expect(emailDomain("Ryan@LRGHomes.com")).toBe("lrghomes.com")
    expect(emailDomain("bad")).toBeNull()
  })

  it("flags known disposable domains and nothing else", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true)
    expect(isDisposableDomain("gmail.com")).toBe(false)
    expect(isDisposableDomain("remax.com")).toBe(false)
  })

  it("flags role-account prefixes case-insensitively", () => {
    expect(isRoleAccount("Info@brokerage.com")).toBe(true)
    expect(isRoleAccount("sales@brokerage.com")).toBe(true)
    expect(isRoleAccount("asha.raghupathy@brokerage.com")).toBe(false)
  })

  it("suggests corrections for common freemail typos, null otherwise", () => {
    expect(typoSuggestion("gmial.com")).toBe("gmail.com")
    expect(typoSuggestion("hotmial.com")).toBe("hotmail.com")
    expect(typoSuggestion("remax.com")).toBeNull()
    expect(typoSuggestion("gmail.com")).toBeNull()
  })
})

describe("tier 2: DNS classification (pure decision logic, resolver injected)", () => {
  it("maps a resolvable domain to ok, an empty domain to dead_domain, an error to dns_unknown", () => {
    expect(classifyDns({ ok: true, via: "mx", hosts: ["mx.example.com"] })).toBe("ok")
    expect(classifyDns({ ok: false, via: null, hosts: [] })).toBe("dead_domain")
    expect(classifyDns({ ok: null, via: null, hosts: [], error: "ETIMEOUT" })).toBe("dns_unknown")
  })
})

describe("SMTP protocol pieces (built for the brief's ask, not run live — see script docstring)", () => {
  it("builds the probe sequence without ever including a DATA command", () => {
    const cmds = buildProbeCommands({ heloDomain: "lrghomesbuys.com", mailFrom: "probe@lrghomesbuys.com", rcptTo: "agent@brokerage.com" })
    expect(cmds).toEqual([
      "EHLO lrghomesbuys.com",
      "MAIL FROM:<probe@lrghomesbuys.com>",
      "RCPT TO:<agent@brokerage.com>",
      "QUIT",
    ])
    expect(cmds.some((c: string) => c.startsWith("DATA"))).toBe(false)
  })

  it("classifies SMTP reply codes: 2xx valid, 5xx invalid, 4xx and garbage unknown (never a verdict)", () => {
    expect(classifySmtpCode(250)).toBe("valid")
    expect(classifySmtpCode(251)).toBe("valid")
    expect(classifySmtpCode(550)).toBe("invalid")
    expect(classifySmtpCode(553)).toBe("invalid")
    expect(classifySmtpCode(450)).toBe("unknown") // greylisted — temp, not a verdict
    expect(classifySmtpCode(421)).toBe("unknown")
    expect(classifySmtpCode("not-a-code")).toBe("unknown")
  })
})

describe("classifyEmail: end-to-end per-address decision with an injected resolver", () => {
  const okResolver = async () => ({ ok: true, via: "mx", hosts: ["mx.example.com"] })
  const deadResolver = async () => ({ ok: false, via: null, hosts: [] })
  const flakyResolver = async () => ({ ok: null, via: null, hosts: [], error: "ETIMEOUT" })

  it("syntax_invalid short-circuits before any DNS lookup", async () => {
    let called = false
    const spy = async () => {
      called = true
      return { ok: true, via: "mx", hosts: [] }
    }
    const r = await classifyEmail("not-an-email", { resolveDomain: spy })
    expect(r.classification).toBe("syntax_invalid")
    expect(called).toBe(false)
  })

  it("disposable domain is caught before DNS", async () => {
    let called = false
    const spy = async () => {
      called = true
      return { ok: true, via: "mx", hosts: [] }
    }
    const r = await classifyEmail("throwaway@mailinator.com", { resolveDomain: spy })
    expect(r.classification).toBe("disposable")
    expect(called).toBe(false)
  })

  it("a resolvable domain is ok and carries advisory flags", async () => {
    const r = await classifyEmail("info@gmial.com", { resolveDomain: okResolver })
    expect(r.classification).toBe("ok")
    expect(r.role_account).toBe(true)
    expect(r.typo_suspect).toBe("gmail.com")
  })

  it("a domain with no MX/A/AAAA is dead_domain", async () => {
    const r = await classifyEmail("agent@some-defunct-brokerage-xyz.com", { resolveDomain: deadResolver })
    expect(r.classification).toBe("dead_domain")
  })

  it("a DNS timeout is dns_unknown, not a bounce verdict", async () => {
    const r = await classifyEmail("agent@flaky-dns-example.com", { resolveDomain: flakyResolver })
    expect(r.classification).toBe("dns_unknown")
  })
})
