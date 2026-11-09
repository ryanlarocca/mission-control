import { describe, expect, it } from "vitest"
import { closeByDay, contractCardLine, parseMoney, underContractReason, type ContractEvent } from "@/lib/deals"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decide, facts } = require("../scripts/judge.js")

// Made-up people and addresses throughout.

const ev: ContractEvent = {
  event: "signed", envelopeId: "abc123", title: "Purchase Agreement - 12 Oak Dr", propertyAddress: "12 Oak Dr, San Jose, CA 95123",
  at: "2026-11-08T01:15:36.040Z", driveLink: null, price: 900000, earnestMoney: 10000, closingDays: 10, sellerName: "Dana Lee", sellers: [],
}

describe("contract terms", () => {
  it("reads the agreement's money fields", () => {
    expect(parseMoney("900,000.00")).toBe(900000)
    expect(parseMoney("$1.2M")).toBe(1200000)
    expect(parseMoney("850k")).toBe(850000)
    expect(parseMoney("")).toBeNull()
    expect(parseMoney("TBD")).toBeNull()
  })
  it("counts closing days from the Pacific signing day", () => {
    // 5:15 PM Nov 7 Pacific is already Nov 8 in UTC — the deal was signed Nov 7.
    expect(closeByDay("2026-11-08T01:15:36.040Z", 10)).toBe("2026-11-17")
    expect(closeByDay("2026-11-08T01:15:36.040Z", null)).toBeNull()
  })
  it("says the deal in one line", () => {
    expect(underContractReason({ price: 900000, close_by: "2026-11-17", signed_at: ev.at }))
      .toBe("Under contract at $900,000 (signed Nov 7, 2026) — closes by Nov 17, 2026 — tap Closed once it records")
    expect(contractCardLine({ status: "recorded", leadId: "x", name: "Dana Lee", closeBy: "2026-11-17" }, ev))
      .toContain("<b>Under contract</b> · $900,000 · close by Nov 17, 2026")
    expect(contractCardLine({ status: "no_match" }, ev)).toContain("Tap 📝 Pending")
  })
})

describe("the judge with a signed contract", () => {
  const today = "2026-11-10"
  const row = (o: Record<string, unknown>) => ({ id: String(Math.random()), lead_type: "call", twilio_number: null, message: "hi", status: "contacted", ...o })
  const signed = [
    row({ created_at: "2026-11-05T17:00:00Z", twilio_number: "+14085550100", message: "Lead: I want to sell" }),
    row({
      created_at: "2026-11-06T20:00:00Z", pending_at: "2026-11-07T12:00:00Z",
      deal_details: { price: 900000, close_by: "2026-11-17", signed_at: "2026-11-08T01:15:36.040Z" },
    }),
  ]
  const none = { state: "none", date: null, owed: null, reason: "", connected: true }

  it("waits for the close-by day instead of chasing", () => {
    const v = decide({ ...none, state: "call_on", date: "2026-11-11", reason: "see where they landed" }, facts(signed), today)
    expect(v.state).toBe("under_contract")
    expect(v.date).toBe("2026-11-17")
    expect(v.enrolAutopilot).toBe(false)
  })
  it("still brings a request from them to Ryan today", () => {
    expect(decide({ ...none, state: "ryan_today", reason: "She asked when escrow opens" }, facts(signed), today))
      .toMatchObject({ state: "ryan_today", date: today })
    expect(decide({ ...none, state: "call_on", owed: "send her the escrow number" }, facts(signed), today))
      .toMatchObject({ state: "ryan_owes", date: today })
  })
  it("keeps showing a past close-by day until it's marked Closed", () => {
    expect(decide(none, facts(signed), "2026-11-20")).toMatchObject({ state: "under_contract", date: "2026-11-20" })
  })
  it("leaves a closed deal alone", () => {
    const closed = [...signed, row({ created_at: "2026-11-18T00:00:00Z", deal_closed_at: "2026-11-17T12:00:00Z" })]
    expect(decide(none, facts(closed), today)).toMatchObject({ state: "closed", date: null })
  })
  it("knows when they reached out after signing", () => {
    expect(facts(signed).inboundSinceContract).toBe(false)
    const after = [...signed, row({ created_at: "2026-11-09T18:00:00Z", twilio_number: "+14085550100", lead_type: "sms", message: "When do we close?" })]
    expect(facts(after).inboundSinceContract).toBe(true)
  })
})
