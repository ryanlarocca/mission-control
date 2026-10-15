import { describe, it, expect } from "vitest"
import {
  formatMergedMessage,
  isMainCommand,
  parseMergedMessage,
  planNameMerge,
  type MergeCandidate,
} from "@/lib/contactIntake"

// "name: X" on a placeholder card when X already has a card
// (briefs/BRIEF_relationships_second_phone_2026-10-15.md, Task 1). The
// planner is pure; the Supabase writes live in renameRelationshipByPhone.

const placeholder = { id: "ph", phone: "+16502797880" }
const vlad: MergeCandidate = { id: "v1", name: "Vlad Rubashevsky", phone: "+16502797872", alt_phones: [], email: "vlad@example.com", category: "Agent", tier: "B" }

describe("planNameMerge", () => {
  it("no other card with the name → plain rename", () => {
    expect(planNameMerge(placeholder, [])).toEqual({ kind: "rename" })
    // the placeholder itself never counts as a match
    expect(planNameMerge(placeholder, [{ ...vlad, id: "ph" }])).toEqual({ kind: "rename" })
  })
  it("one card with the name → merge; its number becomes an extra on the target", () => {
    const plan = planNameMerge(placeholder, [vlad])
    expect(plan).toMatchObject({ kind: "merge", placement: "alt_phones", target: { id: "v1" } })
    if (plan.kind !== "merge") throw new Error("expected merge")
    expect(plan.altPhones).toEqual(["+16502797880"])
  })
  it("target has no main number → the placeholder's number becomes the main number", () => {
    const plan = planNameMerge(placeholder, [{ ...vlad, phone: null, alt_phones: ["+14085550100"] }])
    expect(plan).toMatchObject({ kind: "merge", placement: "phone" })
    if (plan.kind !== "merge") throw new Error("expected merge")
    // the new main is never also an extra
    expect(plan.altPhones).toEqual(["+14085550100"])
  })
  it("extras are de-duplicated and never equal the main number", () => {
    const plan = planNameMerge(placeholder, [{ ...vlad, alt_phones: ["6502797880", "+16502797872", "(408) 555-0100"] }])
    if (plan.kind !== "merge") throw new Error("expected merge")
    expect(plan.altPhones).toEqual(["+16502797880", "+14085550100"])
  })
  it("two cards with the name → ambiguous, nothing planned", () => {
    const other = { ...vlad, id: "v2", phone: "+14085550100", tier: "C" }
    const plan = planNameMerge(placeholder, [vlad, other])
    expect(plan.kind).toBe("ambiguous")
    if (plan.kind !== "ambiguous") throw new Error("expected ambiguous")
    expect(plan.candidates.map((c) => c.id)).toEqual(["v1", "v2"])
  })
})

describe("main reply", () => {
  it("accepts exactly main, any case, optional period", () => {
    expect(isMainCommand("main")).toBe(true)
    expect(isMainCommand("Main.")).toBe(true)
    expect(isMainCommand(" MAIN ")).toBe(true)
    expect(isMainCommand("main number")).toBe(false)
    expect(isMainCommand("remain")).toBe(false)
  })
  it("parses the two numbers back out of the bot's 🔗 message", () => {
    const html = formatMergedMessage({
      success: true, merged: true, id: "v1", name: "Vlad Rubashevsky", category: "Agent", tier: "B",
      mainPhone: "6502797872", addedPhone: "6502797880", placement: "alt_phones", movedTouches: 2,
    })
    expect(html).toBe(
      '🔗 (650) 279-7880 merged into <b>Vlad Rubashevsky</b> (Agent, tier B). Main number stays (650) 279-7872; 7880 added as an extra. 2 calls moved. Reply "main" to make 7880 the number the Call button dials.'
    )
    // Telegram hands the reply_to_message text back without the HTML tags.
    const plain = html.replace(/<\/?b>/g, "")
    expect(parseMergedMessage(plain)).toEqual({ addedPhone: "6502797880", mainPhone: "6502797872", name: "Vlad Rubashevsky" })
  })
  it("still parses when the card has no category or tier", () => {
    const html = formatMergedMessage({
      success: true, merged: true, id: "v1", name: "Vlad Rubashevsky", category: null, tier: null,
      mainPhone: "6502797872", addedPhone: "6502797880", placement: "alt_phones", movedTouches: 0,
    })
    expect(html.startsWith("🔗 (650) 279-7880 merged into <b>Vlad Rubashevsky</b>. Main number stays (650) 279-7872; 7880 added as an extra.")).toBe(true)
    expect(parseMergedMessage(html.replace(/<\/?b>/g, ""))).toEqual({ addedPhone: "6502797880", mainPhone: "6502797872", name: "Vlad Rubashevsky" })
  })
  it("a merge that already made the number main offers no swap", () => {
    const html = formatMergedMessage({
      success: true, merged: true, id: "v1", name: "Vlad Rubashevsky", category: "Agent", tier: null,
      mainPhone: "6502797880", addedPhone: "6502797880", placement: "phone", movedTouches: 0,
    })
    expect(html).toBe("🔗 (650) 279-7880 merged into <b>Vlad Rubashevsky</b> (Agent). Main number is now (650) 279-7880.")
    expect(parseMergedMessage(html.replace(/<\/?b>/g, ""))).toBeNull()
  })
  it("ignores other bot messages", () => {
    expect(parseMergedMessage("✏️ (650) 279-7880 → Vlad Rubashevsky — Relationships card updated.")).toBeNull()
    expect(parseMergedMessage("")).toBeNull()
  })
})
