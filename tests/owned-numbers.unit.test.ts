import { describe, it, expect } from "vitest"
import { isOwnedNumber, OWNED_NUMBERS, CAMPAIGN_MAP, AGENTS_LINE_NUMBER } from "@/lib/leads"

// 2026-09-03: the landing page's "🔔 NEW LEAD" alert SMS is sent from our
// Google Ads number to our Office — Info line. The SMS webhook had no sender
// check, so it wrote a lead whose caller_phone was our own number; clicking
// Call dialed LRG's own voicemail and logged more phantom rows on both legs.
// 33 rows across 4 of our numbers had accumulated this way.

describe("OWNED_NUMBERS", () => {
  it("covers every lead-facing line plus the agents line", () => {
    // 13 in CAMPAIGN_MAP + the agents line = the 14 on the Twilio account.
    expect(OWNED_NUMBERS.size).toBe(Object.keys(CAMPAIGN_MAP).length + 1)
    expect(OWNED_NUMBERS.has(AGENTS_LINE_NUMBER)).toBe(true)
  })
  it("includes each number the webhooks special-case", () => {
    for (const n of ["+16506703914", "+16502043247", "+14084930632", "+14084585442"]) {
      expect(OWNED_NUMBERS.has(n)).toBe(true)
    }
  })
})

describe("isOwnedNumber", () => {
  it("matches the landing-page number that caused the self-call", () => {
    expect(isOwnedNumber("+16506703914")).toBe(true)
  })
  it("matches every owned number in E.164", () => {
    for (const n of Array.from(OWNED_NUMBERS)) expect(isOwnedNumber(n)).toBe(true)
  })
  it("matches unformatted and punctuated variants", () => {
    for (const v of ["6506703914", "1 650-670-3914", "(650) 670-3914", "+1 650.670.3914"]) {
      expect(isOwnedNumber(v)).toBe(true)
    }
  })
  it("does NOT match a real lead's number", () => {
    // Hannah Melotto's actual number from the alert body.
    expect(isOwnedNumber("+12158218810")).toBe(false)
    expect(isOwnedNumber("+14088343828")).toBe(false)
  })
  it("is false for empty, null and short input", () => {
    for (const v of [null, undefined, "", "   ", "1234", "Anonymous"]) {
      expect(isOwnedNumber(v as string | null | undefined)).toBe(false)
    }
  })
  it("does not false-positive on a number sharing only a prefix", () => {
    expect(isOwnedNumber("+16506703915")).toBe(false)
  })
})
