import { describe, it, expect, afterEach, vi } from "vitest"
import { isOwnedNumber, OWNED_NUMBERS, CAMPAIGN_MAP, AGENTS_LINE_NUMBER, FORWARD_TO, OFFICE_NUMBERS } from "@/lib/leads"

// 2026-09-03: the landing page's "🔔 NEW LEAD" alert SMS is sent from our
// Google Ads number to our Office — Info line. The SMS webhook had no sender
// check, so it wrote a lead whose caller_phone was our own number; clicking
// Call dialed LRG's own voicemail and logged more phantom rows on both legs.
// 33 rows across 4 of our numbers had accumulated this way.

describe("OWNED_NUMBERS", () => {
  it("covers every lead-facing line plus the agents line and Ryan's cell", () => {
    // CAMPAIGN_MAP + the agents line = the lines on the Twilio account;
    // FORWARD_TO is Ryan's cell (2026-10-12 consolidation).
    expect(OWNED_NUMBERS.size).toBe(Object.keys(CAMPAIGN_MAP).length + 2)
    expect(OWNED_NUMBERS.has(AGENTS_LINE_NUMBER)).toBe(true)
    expect(OWNED_NUMBERS.has(FORWARD_TO)).toBe(true)
    for (const n of Array.from(OFFICE_NUMBERS)) expect(OWNED_NUMBERS.has(n)).toBe(true)
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

// 2026-10-12: app/api/leads/email/route.ts had its own `LRG_OWN_NUMBERS`
// (CAMPAIGN_MAP keys + FORWARD_TO, last-10-digit form) for the quoted-mailer
// phone filter and the Google Voice self-text guard. It now calls
// isOwnedNumber(); every number the old list held must still be owned, in
// the bare 10-digit form the route's regex extracts.
describe("isOwnedNumber covers the email route's former LRG_OWN_NUMBERS list", () => {
  const oldList = [...Object.keys(CAMPAIGN_MAP), FORWARD_TO].map((n) => n.replace(/\D/g, "").slice(-10))
  it("owns every member in bare 10-digit form", () => {
    expect(oldList.length).toBeGreaterThan(0)
    for (const digits of oldList) {
      expect(digits).toHaveLength(10)
      expect(isOwnedNumber(digits)).toBe(true)
    }
  })
  it("owns Ryan's forward-to cell in E.164", () => {
    expect(isOwnedNumber(FORWARD_TO)).toBe(true)
  })
})

describe("isOwnedNumber env-provided numbers", () => {
  afterEach(() => vi.unstubAllEnvs())
  it("treats TWILIO_NUMBER (click-to-call caller ID) as owned", () => {
    vi.stubEnv("TWILIO_NUMBER", "+17075550100\n") // trailing newline like `vercel env add` ships
    expect(isOwnedNumber("+17075550100")).toBe(true)
    expect(isOwnedNumber("(707) 555-0100")).toBe(true)
  })
  it("treats each entry of LRG_OWN_NUMBERS as owned", () => {
    vi.stubEnv("LRG_OWN_NUMBERS", "+17075550101, 707-555-0102")
    expect(isOwnedNumber("+17075550101")).toBe(true)
    expect(isOwnedNumber("+17075550102")).toBe(true)
    expect(isOwnedNumber("+17075550103")).toBe(false)
  })
  it("is unaffected when the env vars are unset", () => {
    vi.stubEnv("TWILIO_NUMBER", "")
    vi.stubEnv("LRG_OWN_NUMBERS", "")
    expect(isOwnedNumber("+17075550100")).toBe(false)
    expect(isOwnedNumber(FORWARD_TO)).toBe(true)
  })
})
