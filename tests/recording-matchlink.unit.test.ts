import { describe, it, expect, vi, beforeEach } from "vitest"

// BRIEF_TRIAGE_SONNET_DEDUPE_MATCHLINK_2026-10-21 §4. A caller who says their
// address on a voicemail gets property_address on the card via
// analyzeCallTranscript → applyAnalyzeCallResult, and that write must also
// run the mailed-record linker (phone matching is impossible: mail_records
// has no phone column, so the address is the only key for callers).
// Offline: the linker module and the Supabase client are mocked; this pins
// that the recording pipeline's persisters invoke autoLinkMailRecord.

vi.mock("@/lib/mailMatch", () => ({ autoLinkMailRecord: vi.fn().mockResolvedValue(null) }))

// A permissive thenable query builder: every method returns the chain,
// `maybeSingle` resolves to the configured row, awaiting the chain resolves
// to an empty, error-free result.
const state: { existing: Record<string, unknown> | null } = { existing: null }
function chain(): unknown {
  const c: Record<string, unknown> = {}
  const self = new Proxy(c, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null })
      if (prop === "maybeSingle") return async () => ({ data: state.existing, error: null })
      if (prop === "single") return async () => ({ data: state.existing, error: null })
      return () => self
    },
  })
  return self
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => chain() }) }))

import { applyAnalyzeCallResult, applyFollowupOnlyResult, type AnalyzeCallResult } from "@/lib/leads"
import { autoLinkMailRecord } from "@/lib/mailMatch"

const linker = vi.mocked(autoLinkMailRecord)

const RESULT: AnalyzeCallResult = {
  temperature: "warm",
  moment: "invitation_to_talk",
  summary: "Brian called about his duplex at 2127 Los Gatos Almaden Rd and wants a callback.",
  name: "Brian",
  property_address: "2127 Los Gatos Almaden Rd",
  email: null,
  recommended_followup_date: null,
  followup_reason: null,
  is_dnc: false,
  offer_amount: null,
  offer_verbalized: false,
  property_details: [],
}

beforeEach(() => {
  vi.stubEnv("LRG_SUPABASE_URL", "http://localhost")
  vi.stubEnv("LRG_SUPABASE_SERVICE_KEY", "k")
  linker.mockClear()
  state.existing = { name: null, property_address: null, caller_phone: "+14085551212", email: null, offer_amount: null, offer_verbalized_at: null, created_at: "2026-10-21T00:00:00Z", property_details: null }
})

describe("recording pipeline re-runs the mailed-record linker", () => {
  it("applyAnalyzeCallResult links when the analysis carries a property_address", async () => {
    await applyAnalyzeCallResult("lead-1", RESULT)
    expect(linker).toHaveBeenCalledTimes(1)
    expect(linker.mock.calls[0][1]).toBe("lead-1")
  })

  it("links even when the row already held the address (no mail_record_id yet)", async () => {
    state.existing = { ...state.existing!, property_address: "2127 Los Gatos Almaden Rd", name: "Brian" }
    await applyAnalyzeCallResult("lead-2", RESULT)
    expect(linker).toHaveBeenCalledWith(expect.anything(), "lead-2")
  })

  it("applyFollowupOnlyResult (outbound branch) links when it carries an address", async () => {
    await applyFollowupOnlyResult("lead-3", RESULT)
    expect(linker).toHaveBeenCalledWith(expect.anything(), "lead-3")
  })

  it("does not run the linker when the analysis has neither name nor address", async () => {
    await applyAnalyzeCallResult("lead-4", { ...RESULT, name: null, property_address: null })
    await applyFollowupOnlyResult("lead-5", { ...RESULT, name: null, property_address: null })
    expect(linker).not.toHaveBeenCalled()
  })
})
