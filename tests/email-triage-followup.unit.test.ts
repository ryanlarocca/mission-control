import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { triageEmailLead } from "@/lib/leads"

// BRIEF_LEAD_RECOVERY_2026-09-02 Phase 1. Before this, an inbound email could
// not create a follow-up task: /api/follow-ups selects on
// `drip_campaign_type NOT NULL OR recommended_followup_date NOT NULL`, and the
// email path never wrote either column — so Chris Shoemaker's "Give me a call
// if you'd like to discuss timing and pricing" produced nothing at all.
//
// Offline: fetch is stubbed, so these pin the parse + validation rules rather
// than the model's judgment.

const ok = (payload: Record<string, unknown>) =>
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
  } as unknown as Response)

const BASE = {
  temperature: "warm",
  is_dead: false,
  summary: "Seller open to discussing timing and pricing.",
  suggestedReply: "Thanks Chris — what's your timeline?",
  offer_amount: null,
  offer_verbalized: false,
}

// A date far enough out that the long-horizon guard is not involved.
const FUTURE = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10)

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("triageEmailLead — follow-up extraction", () => {
  it("keeps a well-formed date + reason", async () => {
    vi.stubGlobal("fetch", ok({
      ...BASE,
      recommended_followup_date: FUTURE,
      followup_reason: "said 'Give me a call to discuss timing and pricing'",
    }))
    const r = await triageEmailLead("RE: 1450 Merrill St", "Give me a call if you'd like to discuss timing and pricing.")
    expect(r?.recommended_followup_date).toBe(FUTURE)
    expect(r?.followup_reason).toContain("Give me a call")
  })

  it("nulls a date that arrives without a reason", async () => {
    vi.stubGlobal("fetch", ok({ ...BASE, recommended_followup_date: FUTURE, followup_reason: null }))
    const r = await triageEmailLead("s", "b")
    expect(r?.recommended_followup_date).toBeNull()
    expect(r?.followup_reason).toBeNull()
  })

  it("nulls a reason that arrives without a date", async () => {
    vi.stubGlobal("fetch", ok({ ...BASE, recommended_followup_date: null, followup_reason: "wants a call" }))
    const r = await triageEmailLead("s", "b")
    expect(r?.recommended_followup_date).toBeNull()
    expect(r?.followup_reason).toBeNull()
  })

  it("rejects a malformed date rather than passing it to the DB", async () => {
    vi.stubGlobal("fetch", ok({ ...BASE, recommended_followup_date: "next Tuesday", followup_reason: "wants a call" }))
    const r = await triageEmailLead("s", "b")
    expect(r?.recommended_followup_date).toBeNull()
  })

  it("applies the long-horizon guard: 'a couple years' with a near date is cleared", async () => {
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    vi.stubGlobal("fetch", ok({
      ...BASE,
      recommended_followup_date: soon,
      followup_reason: "said to check back in a couple years",
    }))
    const r = await triageEmailLead("s", "b")
    expect(r?.recommended_followup_date).toBeNull()
    expect(r?.followup_reason).toBeNull()
  })

  it("an opt-out yields no follow-up at all", async () => {
    vi.stubGlobal("fetch", ok({
      ...BASE,
      temperature: "cold",
      is_dead: true,
      recommended_followup_date: null,
      followup_reason: null,
    }))
    const r = await triageEmailLead("Remove from list", "please remove me from your mailing list")
    expect(r?.is_dead).toBe(true)
    expect(r?.recommended_followup_date).toBeNull()
  })

  it("still returns the pre-existing fields (no regression)", async () => {
    vi.stubGlobal("fetch", ok({ ...BASE, offer_amount: 800000, offer_verbalized: true, recommended_followup_date: null, followup_reason: null }))
    const r = await triageEmailLead("s", "b")
    expect(r?.temperature).toBe("warm")
    expect(r?.offer_amount).toBe(800000)
    expect(r?.offer_verbalized).toBe(true)
    expect(r?.suggestedReply).toBe(BASE.suggestedReply)
  })
})
