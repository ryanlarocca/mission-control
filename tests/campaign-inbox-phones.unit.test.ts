import { describe, it, expect } from "vitest"
import { describeReplyPhones, parseTriagePhones, planReplyPhones, type ReplyPhone } from "@/lib/campaignInbox"

// Numbers inside agent email replies (briefs/BRIEF_relationships_second_phone_2026-10-15.md,
// Task 3): Haiku returns a "phones" array; only "self" numbers land on the
// card as extras, never as the main number.

describe("parseTriagePhones", () => {
  it("keeps well-formed entries, normalised to 10 digits", () => {
    expect(parseTriagePhones([
      { number: "6502797880", whose: "self", label: "cell" },
      { number: "(650) 279-9865", whose: "other", label: "Alex (partner)" },
      { number: 4085550100, whose: "self", label: "" },
    ])).toEqual([
      { number: "6502797880", whose: "self", label: "cell" },
      { number: "6502799865", whose: "other", label: "Alex (partner)" },
      { number: "4085550100", whose: "self", label: "" },
    ])
  })
  it("drops malformed entries and duplicates", () => {
    expect(parseTriagePhones([
      { number: "279-7880", whose: "self", label: "cell" },            // not 10 digits
      { number: "6502797880", whose: "partner", label: "x" },         // bad whose
      { number: "6502797880", whose: "self" },                        // ok, no label
      { number: "6502797880", whose: "other", label: "again" },       // duplicate number
      "6502797881",                                                   // not an object
      null,
      { whose: "self", label: "no number" },
    ])).toEqual([{ number: "6502797880", whose: "self", label: "" }])
  })
  it("caps at 3 and tolerates a missing or non-array field", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ number: `650279788${i}`, whose: "self", label: `n${i}` }))
    expect(parseTriagePhones(many)).toHaveLength(3)
    expect(parseTriagePhones(undefined)).toEqual([])
    expect(parseTriagePhones("6502797880")).toEqual([])
    expect(parseTriagePhones({ number: "6502797880", whose: "self" })).toEqual([])
  })
})

const vladReply: ReplyPhone[] = [
  { number: "6502797880", whose: "self", label: "cell" },
  { number: "6502799865", whose: "other", label: "Alex (partner)" },
]

describe("planReplyPhones", () => {
  it("adds a self number as an extra; others are noted only", () => {
    const plan = planReplyPhones({ phone: "+16502797872", alt_phones: [] }, vladReply)
    expect(plan.added).toEqual(["6502797880"])
    expect(plan.altPhones).toEqual(["+16502797880"])
  })
  it("skips the card's own number and existing extras", () => {
    const plan = planReplyPhones(
      { phone: "+16502797872", alt_phones: ["+14085550100"] },
      [
        { number: "6502797872", whose: "self", label: "office" },
        { number: "4085550100", whose: "self", label: "cell" },
        { number: "6502797880", whose: "self", label: "new cell" },
      ]
    )
    expect(plan.added).toEqual(["6502797880"])
    expect(plan.altPhones).toEqual(["+14085550100", "+16502797880"])
  })
  it("never touches the main number, even when the card has none", () => {
    const plan = planReplyPhones({ phone: null, alt_phones: null }, vladReply)
    expect(plan.added).toEqual(["6502797880"])
    expect(plan.altPhones).toEqual(["+16502797880"])
  })
  it("nothing to do → empty plan", () => {
    expect(planReplyPhones({ phone: "+16502797872", alt_phones: [] }, [])).toEqual({ added: [], altPhones: [] })
  })
})

describe("describeReplyPhones", () => {
  it("writes the note line and the alert line from the brief", () => {
    const card = { phone: "+16502797872", alt_phones: [] }
    const plan = planReplyPhones(card, vladReply)
    expect(describeReplyPhones(card, vladReply, plan, "Oct 15, 2026")).toEqual({
      note: "Numbers from their Oct 15, 2026 email: 650-279-7880 (cell, added as an extra) · 650-279-9865 (Alex (partner), noted only).",
      alert: "📱 Added 650-279-7880 to the card · Alex (partner): 650-279-9865",
    })
  })
  it("says so when the self number is already on the card", () => {
    const card = { phone: "+16502797872", alt_phones: ["+16502797880"] }
    const phones: ReplyPhone[] = [
      { number: "6502797872", whose: "self", label: "office" },
      { number: "6502797880", whose: "self", label: "" },
    ]
    const out = describeReplyPhones(card, phones, planReplyPhones(card, phones), "Oct 15, 2026")
    expect(out?.note).toBe("Numbers from their Oct 15, 2026 email: 650-279-7872 (office, already the main number) · 650-279-7880 (already an extra).")
    expect(out?.alert).toBe("📱 650-279-7872 already on the card · 650-279-7880 already on the card")
  })
  it("no numbers → no note, no alert line", () => {
    const card = { phone: "+16502797872", alt_phones: [] }
    expect(describeReplyPhones(card, [], planReplyPhones(card, []), "Oct 15, 2026")).toBeNull()
  })
})
