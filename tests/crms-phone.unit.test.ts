import { describe, it, expect } from "vitest"
import { normalizeAltPhones, parseUsPhone10, planPhoneChange, toApiContact, toE164Phone, type RelationshipRow } from "@/lib/relationships"

// Editing the number on the card (briefs/BRIEF_relationships_second_phone_2026-10-15.md,
// Task 2): /api/crms/phone normalises what Ryan typed and reshuffles
// phone / alt_phones with these pure helpers.

describe("parseUsPhone10", () => {
  it("accepts a 10-digit US number in any formatting", () => {
    expect(parseUsPhone10("(650) 279-7880")).toBe("6502797880")
    expect(parseUsPhone10("650.279.7880")).toBe("6502797880")
    expect(parseUsPhone10("+1 650 279 7880")).toBe("6502797880")
    expect(parseUsPhone10("16502797880")).toBe("6502797880")
  })
  it("rejects anything that is not 10 digits", () => {
    expect(parseUsPhone10("279-7880")).toBeNull()
    expect(parseUsPhone10("650279788")).toBeNull()
    expect(parseUsPhone10("65027978801")).toBeNull()
    expect(parseUsPhone10("+44 20 7946 0958")).toBeNull()
    expect(parseUsPhone10("")).toBeNull()
    expect(parseUsPhone10(null)).toBeNull()
  })
})

describe("normalizeAltPhones", () => {
  it("stores E.164, de-duplicates, drops the main number and junk", () => {
    expect(toE164Phone("650-279-7880")).toBe("+16502797880")
    expect(normalizeAltPhones(["6502797880", "+16502797880", "(650) 279-7872", "junk", null, "408"], "+16502797872"))
      .toEqual(["+16502797880"])
  })
  it("empty in, empty out", () => {
    expect(normalizeAltPhones(null, null)).toEqual([])
    expect(normalizeAltPhones([], "+16502797872")).toEqual([])
  })
})

describe("planPhoneChange", () => {
  it("new number becomes phone; the old main is kept as an extra", () => {
    expect(planPhoneChange({ phone: "+16502797872", alt_phones: [] }, "6502797880"))
      .toEqual({ phone: "+16502797880", alt_phones: ["+16502797872"] })
  })
  it("promoting an extra pulls it out of the extras list", () => {
    expect(planPhoneChange({ phone: "+16502797872", alt_phones: ["+16502797880", "+14085550100"] }, "6502797880"))
      .toEqual({ phone: "+16502797880", alt_phones: ["+14085550100", "+16502797872"] })
  })
  it("a card with no number just gets one", () => {
    expect(planPhoneChange({ phone: null, alt_phones: null }, "6502797880"))
      .toEqual({ phone: "+16502797880", alt_phones: [] })
  })
  it("the old main is not doubled when it was already an extra", () => {
    expect(planPhoneChange({ phone: "+16502797872", alt_phones: ["+16502797872"] }, "6502797880"))
      .toEqual({ phone: "+16502797880", alt_phones: ["+16502797872"] })
  })
  it("refuses a non-10-digit number", () => {
    expect(planPhoneChange({ phone: "+16502797872", alt_phones: [] }, "7880")).toBeNull()
  })
})

describe("toApiContact", () => {
  it("exposes the extras as 10-digit altPhones for display", () => {
    const row: RelationshipRow = {
      id: "v1", name: "Vlad Rubashevsky", phone: "+16502797872", email: null, alt_phones: ["+16502797880", "bad"],
      source: null, category: "Agent", tier: "B", notes: null, enriched_at: null, last_contacted_at: null,
      snooze_until: null, source_lead_id: null, status: "active", cleanup_verdict: null, cleanup_reviewed_at: null,
    }
    const c = toApiContact(row)
    expect(c.phone).toBe("6502797872")
    expect(c.altPhones).toEqual(["6502797880"])
  })
})
