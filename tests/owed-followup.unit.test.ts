import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { clampOwedFollowup, mentionsOwedCommitment, triageEmailLead, analyzeCallTranscript } from "@/lib/leads"
import { OWED_PREFIX, isOwedReason, stripOwedPrefix } from "@/lib/next-touch"
import { completeText } from "@/lib/llm"

// BRIEF_OWED_FOLLOWUP_NEXT_DAY_2026-10-14. Sunday Oct 12 Ryan told Herb
// Bivens "in the next couple of days or so I can text you an offer, ballpark
// wise". The analyzer mapped that through the seller-timeline table and
// padded it "to confirm the text was received", so the task came due
// 2026-10-16 — AFTER the promise was supposed to be kept. Ryan's rule: when
// he promises to give someone a number, the follow-up is the next day.
//
// clampOwedFollowup is the hard guard behind the prompt rule. Pure function
// of (date, reason, today) — no Date.now() — so these are deterministic.

vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>()
  return { ...actual, completeText: vi.fn(), hasLlmKey: () => true }
})

const model = vi.mocked(completeText)
const ok = (payload: Record<string, unknown>) =>
  model.mockResolvedValue({ text: JSON.stringify(payload), stopReason: "end_turn", truncated: false })

// Herb's exact analyzer output (2026-10-12), 4 days out from the call.
const HERB_TODAY = "2026-10-12"
const HERB_REASON =
  "Ryan committed to texting an offer 'in a couple of days or so' — follow up in 3-4 days to confirm the text was received"
const HERB_DATE = "2026-10-16"

beforeEach(() => {
  model.mockReset()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("clampOwedFollowup", () => {
  it("(a) Herb's exact reason + a date 4 days out → clamped to tomorrow, reason prefixed", () => {
    const r = clampOwedFollowup(HERB_DATE, HERB_REASON, HERB_TODAY)
    expect(r.date).toBe("2026-10-13")
    expect(r.reason).toBe(`${OWED_PREFIX}${HERB_REASON}`)
    expect(isOwedReason(r.reason)).toBe(true)
    expect(stripOwedPrefix(r.reason!)).toBe(HERB_REASON)
  })

  it("(b) a seller-timeline reason is untouched", () => {
    const reason = "Caller said 'call me next week' — follow up in 7 days."
    const r = clampOwedFollowup("2026-10-20", reason, "2026-10-13")
    expect(r).toEqual({ date: "2026-10-20", reason })
  })

  it("(c) a Friday today → Saturday date, no weekend skip", () => {
    // 2026-10-16 is a Friday.
    expect(new Date("2026-10-16T00:00:00Z").getUTCDay()).toBe(5)
    const r = clampOwedFollowup("2026-10-21", "I'll send you the comps by Wednesday", "2026-10-16")
    expect(r.date).toBe("2026-10-17")
    expect(new Date(r.date! + "T00:00:00Z").getUTCDay()).toBe(6)
    expect(r.reason).toMatch(/^Owed: /)
  })

  it("(d) model already returned tomorrow → untouched, no double prefix", () => {
    const already = `${OWED_PREFIX}Text Herb a ballpark offer — Ryan said 'I can text you an offer'`
    const r1 = clampOwedFollowup("2026-10-13", already, HERB_TODAY)
    expect(r1).toEqual({ date: "2026-10-13", reason: already })
    expect(r1.reason!.indexOf(OWED_PREFIX, 1)).toBe(-1)

    // A plain (un-prefixed) reason that is already due tomorrow is also left alone.
    const plain = "Text Herb a ballpark offer — Ryan said 'I can text you an offer'"
    expect(clampOwedFollowup("2026-10-13", plain, HERB_TODAY)).toEqual({ date: "2026-10-13", reason: plain })
    // And a stored reason that already carries the prefix is never prefixed twice.
    const r2 = clampOwedFollowup("2026-10-20", already, HERB_TODAY)
    expect(r2.date).toBe("2026-10-13")
    expect(r2.reason).toBe(already)
  })

  it("(e) long-horizon guard clears 'couple years' + a near date before the clamp runs", async () => {
    // Through the real email path: guard runs first and nulls both fields,
    // so the clamp has nothing to act on — no resurrected tomorrow task.
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    ok({
      temperature: "warm",
      is_dead: false,
      summary: "s",
      suggestedReply: "r",
      offer_amount: null,
      offer_verbalized: false,
      recommended_followup_date: soon,
      followup_reason: "I'll send comps — seller said check back in a couple years",
    })
    const r = await triageEmailLead("s", "b")
    expect(r?.recommended_followup_date).toBeNull()
    expect(r?.followup_reason).toBeNull()
  })

  it("rolls the calendar: month end and year end", () => {
    expect(clampOwedFollowup("2026-11-15", "I'll email you the number", "2026-10-31").date).toBe("2026-11-01")
    expect(clampOwedFollowup("2027-01-15", "I'll email you the number", "2026-12-31").date).toBe("2027-01-01")
  })

  it("is a no-op without a date, without a reason, or with a malformed today", () => {
    expect(clampOwedFollowup(null, HERB_REASON, HERB_TODAY)).toEqual({ date: null, reason: HERB_REASON })
    expect(clampOwedFollowup(HERB_DATE, null, HERB_TODAY)).toEqual({ date: HERB_DATE, reason: null })
    expect(clampOwedFollowup(HERB_DATE, HERB_REASON, "today")).toEqual({ date: HERB_DATE, reason: HERB_REASON })
  })
})

describe("mentionsOwedCommitment", () => {
  it("matches Ryan's promises in first person and reported", () => {
    for (const r of [
      "I'll text you an offer in the next couple of days",
      "I will send over the comps",
      "I can email you a number by Friday",
      "I am going to put together a ballpark",
      "told him I'd send a price",
      "let me look and I'll get back to you",
      "Ryan committed to texting an offer",
      "Ryan promised to send comps",
      "Ryan said he'd email a number next week",
      "Ryan will shoot him a text with the offer",
      "Ryan said 'I'll text you an offer'",
      "Ryan’s words: ‘I’ll send you the comps’",
    ]) {
      expect(mentionsOwedCommitment(r), r).toBe(true)
    }
  })

  it("ignores seller timelines, including the seller's own first-person quotes", () => {
    for (const r of [
      "Caller said 'call me next week' — follow up in 7 days.",
      "Seller said 'maybe in a year or two' — follow up ~1 year out.",
      "Wants 1.9M, Ryan offered 1.5M — price gap, revisit in ~6 months.",
      "Brief voicemail with no detail — routine 6-month nurture check-in.",
      "Seller said 'I'll get back to you next week' — follow up in 7 days.",
      "Herb mentioned he will send Ryan the tenant info — check in 2 weeks.",
      "Caller asked Ryan to 'call me back next week'",
    ]) {
      expect(mentionsOwedCommitment(r), r).toBe(false)
    }
  })
})

describe("analyzeCallTranscript applies the owed clamp", () => {
  const BASE = {
    temperature: "warm",
    moment: "offer_requested",
    summary: "Herb called about 409 Center St.",
    name: "Herb Bivens",
    property_address: "409 Center St, Santa Cruz",
    email: null,
    is_dnc: false,
    offer_amount: null,
    offer_verbalized: false,
    property_details: [],
  }
  const today = new Date().toISOString().slice(0, 10)
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const fourDays = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10)

  it("clamps a padded 'to confirm receipt' date to tomorrow", async () => {
    ok({ ...BASE, recommended_followup_date: fourDays, followup_reason: HERB_REASON })
    const r = await analyzeCallTranscript("…in the next couple of days or so I can text you an offer, ballpark wise.")
    expect(r?.recommended_followup_date).toBe(tomorrow)
    expect(r?.followup_reason).toBe(`${OWED_PREFIX}${HERB_REASON}`)
    expect(today < tomorrow).toBe(true)
  })

  it("leaves a seller-timeline follow-up alone", async () => {
    const reason = "Caller asked Ryan to 'call me back next week' — follow up in 7 days."
    const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    // invitation_to_talk: an offer_requested moment is pulled to tomorrow by
    // clampOfferRequestedFollowup (2026-10-24), which is not this case.
    ok({ ...BASE, moment: "invitation_to_talk", recommended_followup_date: week, followup_reason: reason })
    const r = await analyzeCallTranscript("Call me back next week.")
    expect(r?.recommended_followup_date).toBe(week)
    expect(r?.followup_reason).toBe(reason)
  })
})
