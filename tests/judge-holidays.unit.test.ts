import { describe, it, expect } from "vitest"
import { createRequire } from "node:module"

// Ryan, 2026-11-17: no calls on Thanksgiving or over Christmas–New Year's,
// but a lead isn't parked for the whole season — only those windows move.
// Dates the person named stay as said. Made-up people only.
const require = createRequire(import.meta.url)
const { facts, decide, holidayShift } = require("../scripts/judge.js")

const TODAY = "2026-11-17"
const talked = [
  { id: "in", created_at: "2026-11-16T22:00:00Z", lead_type: "call", twilio_number: "+15550001", message: "Lead: hi Ryan: hi", notes: null },
]
const callOn = (date: string, dateNamed = false) => ({ state: "call_on", date, dateNamed, reason: "Check back.", owed: null })

describe("holidayShift", () => {
  it("Thanksgiving Wed–Sun → the Monday after", () => {
    expect(holidayShift("2026-11-25")).toBe("2026-11-30") // Wed before
    expect(holidayShift("2026-11-26")).toBe("2026-11-30") // Thanksgiving 2026
    expect(holidayShift("2026-11-29")).toBe("2026-11-30") // Sunday
    expect(holidayShift("2027-11-25")).toBe("2027-11-29") // Thanksgiving 2027
  })
  it("the rest of Thanksgiving week and early December stay put", () => {
    expect(holidayShift("2026-11-24")).toBe("2026-11-24")
    expect(holidayShift("2026-11-30")).toBe("2026-11-30")
    expect(holidayShift("2026-12-15")).toBe("2026-12-15")
    expect(holidayShift("2026-12-19")).toBe("2026-12-19")
  })
  it("Dec 20 – Jan 3 → first weekday on or after Jan 4", () => {
    expect(holidayShift("2026-12-20")).toBe("2027-01-04") // Jan 4 2027 is a Monday
    expect(holidayShift("2026-12-25")).toBe("2027-01-04")
    expect(holidayShift("2027-01-03")).toBe("2027-01-04")
    expect(holidayShift("2027-12-28")).toBe("2028-01-04") // Tuesday
    expect(holidayShift("2028-12-24")).toBe("2029-01-04") // Thursday
    expect(holidayShift("2025-12-30")).toBe("2026-01-05") // Jan 4 2026 is a Sunday
  })
  it("other days and null pass through", () => {
    expect(holidayShift("2027-01-07")).toBe("2027-01-07")
    expect(holidayShift("2027-07-04")).toBe("2027-07-04")
    expect(holidayShift(null)).toBe(null)
  })
})

describe("decide applies the holiday rule", () => {
  it("a date the judge worked out moves out of the window", () => {
    expect(decide(callOn("2026-12-29"), facts(talked), TODAY).date).toBe("2027-01-04")
    expect(decide(callOn("2026-11-26"), facts(talked), TODAY).date).toBe("2026-11-30")
  })
  it("a date they named stays", () => {
    expect(decide(callOn("2026-12-28", true), facts(talked), TODAY).date).toBe("2026-12-28")
  })
  it("today stays today", () => {
    expect(decide(callOn("2026-11-26"), facts(talked), "2026-11-26").date).toBe("2026-11-26")
  })
  it("a quiet year that lands on Christmas moves to January", () => {
    const rows = [{ id: "q", created_at: "2025-12-24T20:00:00Z", lead_type: "sms", twilio_number: "+15550001", message: "not selling", notes: null }]
    const v = decide({ state: "quiet_until", date: null, reason: "Not selling.", owed: null }, facts(rows), "2025-12-24")
    expect(v.date).toBe("2027-01-04")
  })
})

describe("a price gap the model dated today", () => {
  it("goes six months out when the reason says six months", () => {
    const v = decide({ state: "call_on", date: TODAY, dateNamed: false, reason: "Turned down your offer — checking back in six months.", owed: null }, facts(talked), TODAY)
    expect(v.date).toBe("2027-05-17")
  })
  it("a call-back for today with no six months stays today", () => {
    const v = decide({ state: "call_on", date: TODAY, dateNamed: true, reason: "Said call this afternoon.", owed: null }, facts(talked), TODAY)
    expect(v.date).toBe(TODAY)
  })
})

