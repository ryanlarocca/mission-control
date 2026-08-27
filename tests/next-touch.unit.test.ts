import { describe, it, expect } from "vitest"
import { resolveNextTouch, type NextTouchInput } from "@/lib/next-touch"

// long_term_nurture touch #1 is an email touch (60d). A lead with no email
// must NOT surface that touch — the follow-up call becomes primary.
const base: NextTouchInput = {
  dripCampaignType: "long_term_nurture",
  dripTouchNumber: 0,
  lastDripSentAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  hasPhone: true,
  status: "nurture",
  recommendedFollowupDate: "2026-12-01",
  followupReason: "call back in Dec",
  now: new Date("2026-08-27T12:00:00.000Z"),
}

describe("resolveNextTouch — unsendable forecasts", () => {
  it("drops an email forecast when the cluster has no email", () => {
    const r = resolveNextTouch({ ...base, hasEmail: false })
    expect(r.primary?.kind).toBe("call")
    expect(r.primary?.due).toBe("2026-12-01")
    expect(r.secondary).toBeNull()
  })
  it("keeps the email forecast when an email is on file", () => {
    const r = resolveNextTouch({ ...base, hasEmail: true })
    expect(r.primary?.kind).toBe("drip")
    expect(r.primary?.channel).toBe("email")
    expect(r.secondary?.kind).toBe("call")
  })
  it("defaults hasEmail to true for older callers", () => {
    expect(resolveNextTouch(base).primary?.kind).toBe("drip")
  })
  it("still surfaces a queued drip row regardless of hasEmail", () => {
    const r = resolveNextTouch({
      ...base, hasEmail: false,
      queuedDrip: { id: "q1", touchNumber: 1, channel: "email", campaignType: "long_term_nurture", createdAt: "2026-08-20T00:00:00.000Z", message: "hi", subject: "s" },
    })
    expect(r.primary?.isQueued).toBe(true)
  })
})
