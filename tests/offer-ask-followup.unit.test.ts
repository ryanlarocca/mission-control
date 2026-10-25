import { describe, expect, it } from "vitest"
import { clampOfferRequestedFollowup, OFFER_ASK_PREFIX } from "@/lib/leads"

// Ryan 2026-10-24: a seller asking for a number is followed up the next day.
describe("clampOfferRequestedFollowup", () => {
  const today = "2026-10-24"
  it("pulls a far-out date to tomorrow and labels it", () => {
    const r = clampOfferRequestedFollowup("offer_requested", false, "2026-12-24", "said 'next couple of months'", today)
    expect(r.date).toBe("2026-10-25")
    expect(r.reason).toBe(OFFER_ASK_PREFIX + "said 'next couple of months'")
  })
  it("sets tomorrow when the model gave no date", () => {
    const r = clampOfferRequestedFollowup("offer_requested", false, null, null, today)
    expect(r.date).toBe("2026-10-25")
    expect(r.reason?.startsWith(OFFER_ASK_PREFIX)).toBe(true)
  })
  it("keeps today if the model already chose it", () => {
    expect(clampOfferRequestedFollowup("offer_requested", false, "2026-10-24", "x", today).date).toBe("2026-10-24")
  })
  it("leaves it alone once Ryan has given a number", () => {
    expect(clampOfferRequestedFollowup("offer_requested", true, "2026-12-24", "x", today)).toEqual({ date: "2026-12-24", reason: "x" })
  })
  it("leaves other moments alone", () => {
    expect(clampOfferRequestedFollowup("soft_no", false, "2027-04-01", "x", today)).toEqual({ date: "2027-04-01", reason: "x" })
  })
})
