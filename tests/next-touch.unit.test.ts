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

// Chris Shoemaker, 2026-09-02: the cluster's drip stamp sat on a `dead` intake
// row while a newer `contacted` row supplied the cluster status, so the card
// forecast a drip the engine would never send (it gates status and
// drip_campaign_type on the same row).
describe("resolveNextTouch — dripStatus gates the forecast on the stamped row", () => {
  it("suppresses the drip forecast when the stamped row is dead", () => {
    const r = resolveNextTouch({ ...base, status: "contacted", dripStatus: "dead" })
    expect(r.primary?.kind).toBe("call")
    expect(r.secondary).toBeNull()
  })
  it("does not suppress the follow-up call — that still surfaces", () => {
    const r = resolveNextTouch({ ...base, status: "contacted", dripStatus: "dead" })
    expect(r.primary?.due).toBe("2026-12-01")
    expect(r.primary?.reason).toBe("call back in Dec")
  })
  it("keeps the forecast when the stamped row is live", () => {
    const r = resolveNextTouch({ ...base, status: "contacted", dripStatus: "nurture" })
    expect(r.primary?.kind).toBe("drip")
  })
  it("falls back to status when dripStatus is absent", () => {
    expect(resolveNextTouch({ ...base, status: "dead" }).primary?.kind).toBe("call")
    expect(resolveNextTouch({ ...base, status: "nurture" }).primary?.kind).toBe("drip")
  })
})

// Grace Chang, 2026-09-03: an email-only lead (no phone on the cluster) whose
// follow-up rendered as "Follow-up call · today". The Call button was already
// hidden, but the heading still told Ryan to phone someone we have no number
// for. The touch now carries the channel that is actually actionable.
describe("resolveCallTouch — follow-up channel reflects what's actionable", () => {
  const noDrip = { ...base, dripCampaignType: null, hasPhone: true }
  it("marks the follow-up email-only when the cluster has no phone", () => {
    const r = resolveNextTouch({ ...noDrip, hasPhone: false })
    expect(r.primary?.kind).toBe("call")
    expect(r.primary?.channel).toBe("email")
  })
  it("leaves channel null when a phone IS on file (a real call)", () => {
    const r = resolveNextTouch({ ...noDrip, hasPhone: true })
    expect(r.primary?.kind).toBe("call")
    expect(r.primary?.channel).toBeNull()
  })
  it("still surfaces the follow-up rather than dropping it", () => {
    // Grace asked "what you will offer?" — the work is real even with no
    // phone, so this must never be filtered out the way an unsendable drip is.
    const r = resolveNextTouch({ ...noDrip, hasPhone: false, hasEmail: true })
    expect(r.primary).not.toBeNull()
    expect(r.primary?.due).toBe("2026-12-01")
    expect(r.primary?.reason).toBe("call back in Dec")
  })
})
