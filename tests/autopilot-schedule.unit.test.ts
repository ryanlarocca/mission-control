import { describe, it, expect } from "vitest"
import { receivedCount, lastContactAt, reentryPlan, nextTextAt, REENTRY_DAYS } from "@/lib/autopilotSchedule"

const DAY = 86_400_000
const NOW = new Date("2026-11-13T18:00:00.000Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString()

// Pat: got texts #1 and #2, then replied.
const touchRow = (n: number, created_at: string) => ({
  lead_type: "drip_imessage", twilio_number: null, message: "hi Pat", notes: `[autopilot #${n} of 8 · 12 Elm St]`, created_at,
})
const inbound = (created_at: string) => ({ lead_type: "sms", twilio_number: "+15550100", message: "yes still mine", notes: null, created_at })
const placeholder = (created_at: string) => ({ lead_type: "call", twilio_number: null, message: null, notes: "imported", created_at })

describe("receivedCount", () => {
  it("is 0 with no autopilot rows", () => {
    expect(receivedCount([inbound(daysAgo(5)), placeholder(daysAgo(90))])).toBe(0)
  })
  it("takes the highest N", () => {
    expect(receivedCount([touchRow(1, daysAgo(60)), touchRow(3, daysAgo(10)), touchRow(2, daysAgo(30))])).toBe(3)
  })
})

describe("lastContactAt", () => {
  it("is null with nothing real", () => {
    expect(lastContactAt([placeholder(daysAgo(1))])).toBeNull()
  })
  it("ignores import placeholders (outbound, no message)", () => {
    expect(lastContactAt([inbound(daysAgo(40)), placeholder(daysAgo(2))])).toBe(daysAgo(40))
  })
  it("counts Ryan's outbound with a message and drip texts", () => {
    expect(lastContactAt([inbound(daysAgo(40)), { lead_type: "sms", twilio_number: null, message: "call me", created_at: daysAgo(20) }])).toBe(daysAgo(20))
    expect(lastContactAt([inbound(daysAgo(40)), touchRow(2, daysAgo(10))])).toBe(daysAgo(10))
  })
  it("a drip row with twilio_number set is still a drip text, and an inbound counts", () => {
    expect(lastContactAt([inbound(daysAgo(3)), touchRow(1, daysAgo(50))])).toBe(daysAgo(3))
  })
})

describe("reentryPlan", () => {
  it("first time: nothing received, no pinned time", () => {
    const p = reentryPlan([inbound(daysAgo(4))], NOW)
    expect(p).toEqual({ received: 0, finished: false, nextAt: null, lastTextAt: null })
  })
  it("back on with a contact 4 days ago: 30 days after that contact", () => {
    const p = reentryPlan([touchRow(1, daysAgo(60)), touchRow(2, daysAgo(30)), inbound(daysAgo(4))], NOW)
    expect(p.received).toBe(2)
    expect(p.finished).toBe(false)
    expect(p.nextAt).toBe(new Date(new Date(daysAgo(4)).getTime() + REENTRY_DAYS * DAY).toISOString())
    expect(p.lastTextAt).toBe(daysAgo(30))
  })
  it("back on with the last contact 200 days ago: now", () => {
    const p = reentryPlan([touchRow(1, daysAgo(200)), inbound(daysAgo(200))], NOW)
    expect(p.received).toBe(1)
    expect(p.nextAt).toBe(NOW.toISOString())
  })
  it("all 8 received: finished", () => {
    const rows = Array.from({ length: 8 }, (_, i) => touchRow(i + 1, daysAgo(400 - i * 30)))
    const p = reentryPlan(rows, NOW)
    expect(p.finished).toBe(true)
    expect(p.nextAt).toBeNull()
  })
})

describe("nextTextAt", () => {
  const base = { drip_touch_number: 1, last_drip_sent_at: "2026-10-01T00:00:00.000Z", created_at: "2026-09-01T00:00:00.000Z" }
  it("explicit autopilot_next_at wins", () => {
    const r = nextTextAt({ ...base, autopilot_next_at: "2026-12-25T00:00:00.000Z" })
    expect(r?.touch).toBe(2)
    expect(r?.at.toISOString()).toBe("2026-12-25T00:00:00.000Z")
  })
  it("touch 2 is 30 days after the last text", () => {
    expect(nextTextAt(base)?.at.toISOString()).toBe("2026-10-31T00:00:00.000Z")
  })
  it("touch 3 is 90 days after the last text", () => {
    const r = nextTextAt({ ...base, drip_touch_number: 2 })
    expect(r?.touch).toBe(3)
    expect(r?.at.toISOString()).toBe("2026-12-30T00:00:00.000Z")
  })
  it("falls back to autopilot_since then created_at for the clock", () => {
    expect(nextTextAt({ drip_touch_number: 0, autopilot_since: "2026-11-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" })?.at.toISOString()).toBe("2026-11-01T00:00:00.000Z")
    expect(nextTextAt({ drip_touch_number: 1, created_at: "2026-01-01T00:00:00.000Z" })?.at.toISOString()).toBe("2026-01-31T00:00:00.000Z")
  })
  it("a later hold pushes it out; an earlier hold does not", () => {
    expect(nextTextAt({ ...base, autopilot_hold_until: "2027-02-01T00:00:00.000Z" })?.at.toISOString()).toBe("2027-02-01T00:00:00.000Z")
    expect(nextTextAt({ ...base, autopilot_hold_until: "2026-10-05T00:00:00.000Z" })?.at.toISOString()).toBe("2026-10-31T00:00:00.000Z")
  })
  it("is null once all 8 are sent or the sequence is done", () => {
    expect(nextTextAt({ ...base, drip_touch_number: 8 })).toBeNull()
    expect(nextTextAt({ ...base, autopilot_done_at: "2026-11-01T00:00:00.000Z" })).toBeNull()
  })
})
