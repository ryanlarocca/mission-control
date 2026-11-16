import { describe, it, expect } from "vitest"
import { createRequire } from "node:module"

// The judge's rule-9 exception (2026-11-16): someone already worked through
// to autopilot whose number can't take texts. Ryan's unanswered call is their
// check-in by phone — 6 months, then a year — not a fresh 1/3/7/14 chase.
// Made-up people only.
const require = createRequire(import.meta.url)
const { facts, decide } = require("../scripts/judge.js")

const CHASE = { state: "chase", date: null, reason: "No real conversation yet.", owed: null }
const TODAY = "2026-11-16"

const row = (created_at: string, lead_type: string, extra: Record<string, unknown> = {}) => ({
  id: `${lead_type}-${created_at}`, created_at, lead_type, twilio_number: null, message: null, notes: null, ...extra,
})
const theyCalled = row("2026-04-29T20:00:00Z", "call", { twilio_number: "+15550001" })
const autoText = row("2026-11-06T00:16:00Z", "drip_imessage", { message: "Hi Pat…", notes: "[autopilot #1 · SM123]" })
const ryanCall = (at: string) => row(at, "call", { message: "Lead: Hello, we are not available now. Please leave your name…" })

describe("judge: can't-text, past autopilot", () => {
  it("one unanswered call → 6 months out", () => {
    const rows = [theyCalled, { ...autoText, is_bad_number: true }, ryanCall("2026-11-16T20:47:00Z")]
    const v = decide(CHASE, facts(rows), TODAY)
    expect(v.date).toBe("2027-05-16")
    expect(v.enrolAutopilot).toBe(false)
  })

  it("a second unanswered call → a year out, and asks about marking dead", () => {
    const rows = [theyCalled, { ...autoText, is_bad_number: true }, ryanCall("2026-11-16T20:47:00Z"), ryanCall("2027-05-17T18:00:00Z")]
    const v = decide(CHASE, facts(rows), "2027-05-17")
    expect(v.date).toBe("2028-05-17")
    expect(v.reason).toMatch(/Mark dead\?/)
  })

  it("a number that can take texts keeps the normal ladder", () => {
    const rows = [theyCalled, autoText, ryanCall("2026-11-16T20:47:00Z")]
    const v = decide(CHASE, facts(rows), TODAY)
    expect(v.date).toBe("2026-11-17")
  })

  it("a new lead (never on autopilot) keeps the normal ladder even if it can't take texts", () => {
    const rows = [{ ...theyCalled, created_at: "2026-11-15T20:00:00Z", is_bad_number: true }, ryanCall("2026-11-16T20:47:00Z")]
    const v = decide(CHASE, facts(rows), TODAY)
    expect(v.date).toBe("2026-11-17")
  })

  it("they reached out after the calls → the count starts over", () => {
    const rows = [theyCalled, { ...autoText, is_bad_number: true }, ryanCall("2026-11-16T20:47:00Z"), row("2026-11-17T18:00:00Z", "voicemail", { twilio_number: "+15550001" })]
    expect(facts(rows).triesSinceAutopilot).toHaveLength(0)
  })
})
