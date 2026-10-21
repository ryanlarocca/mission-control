import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { triageEmailLead, analyzeCallTranscript } from "@/lib/leads"
import { completeText } from "@/lib/llm"

// BRIEF_LEAD_RECOVERY_2026-09-02 Phase 1. Before this, an inbound email could
// not create a follow-up task: /api/follow-ups selects on
// `drip_campaign_type NOT NULL OR recommended_followup_date NOT NULL`, and the
// email path never wrote either column — so Chris Shoemaker's "Give me a call
// if you'd like to discuss timing and pricing" produced nothing at all.
//
// Offline: the model call (lib/llm completeText) is mocked, so these pin the
// parse + validation rules rather than the model's judgment.

vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>()
  return { ...actual, completeText: vi.fn(), hasLlmKey: () => true }
})

const model = vi.mocked(completeText)
const ok = (payload: Record<string, unknown>) =>
  model.mockResolvedValue({ text: JSON.stringify(payload), stopReason: "end_turn", truncated: false })

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
  model.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("triageEmailLead — follow-up extraction", () => {
  it("keeps a well-formed date + reason", async () => {
    ok({
      ...BASE,
      recommended_followup_date: FUTURE,
      followup_reason: "said 'Give me a call to discuss timing and pricing'",
    })
    const r = await triageEmailLead("RE: 1450 Merrill St", "Give me a call if you'd like to discuss timing and pricing.")
    expect(r?.recommended_followup_date).toBe(FUTURE)
    expect(r?.followup_reason).toContain("Give me a call")
  })

  it("nulls a date that arrives without a reason", async () => {
    ok({ ...BASE, recommended_followup_date: FUTURE, followup_reason: null })
    const r = await triageEmailLead("s", "b")
    expect(r?.recommended_followup_date).toBeNull()
    expect(r?.followup_reason).toBeNull()
  })

  it("nulls a reason that arrives without a date", async () => {
    ok({ ...BASE, recommended_followup_date: null, followup_reason: "wants a call" })
    const r = await triageEmailLead("s", "b")
    expect(r?.recommended_followup_date).toBeNull()
    expect(r?.followup_reason).toBeNull()
  })

  it("rejects a malformed date rather than passing it to the DB", async () => {
    ok({ ...BASE, recommended_followup_date: "next Tuesday", followup_reason: "wants a call" })
    const r = await triageEmailLead("s", "b")
    expect(r?.recommended_followup_date).toBeNull()
  })

  it("applies the long-horizon guard: 'a couple years' with a near date is cleared", async () => {
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    ok({
      ...BASE,
      recommended_followup_date: soon,
      followup_reason: "said to check back in a couple years",
    })
    const r = await triageEmailLead("s", "b")
    expect(r?.recommended_followup_date).toBeNull()
    expect(r?.followup_reason).toBeNull()
  })

  it("an opt-out yields no follow-up at all", async () => {
    ok({
      ...BASE,
      temperature: "cold",
      is_dead: true,
      recommended_followup_date: null,
      followup_reason: null,
    })
    const r = await triageEmailLead("Remove from list", "please remove me from your mailing list")
    expect(r?.is_dead).toBe(true)
    expect(r?.recommended_followup_date).toBeNull()
  })

  it("still returns the pre-existing fields (no regression)", async () => {
    ok({ ...BASE, offer_amount: 800000, offer_verbalized: true, recommended_followup_date: null, followup_reason: null })
    const r = await triageEmailLead("s", "b")
    expect(r?.temperature).toBe("warm")
    expect(r?.offer_amount).toBe(800000)
    expect(r?.offer_verbalized).toBe(true)
    expect(r?.suggestedReply).toBe(BASE.suggestedReply)
  })

  it("tolerates a sentence of commentary after the JSON object", async () => {
    model.mockResolvedValue({
      text: `Here is the triage:\n${JSON.stringify({ ...BASE, recommended_followup_date: null, followup_reason: null })}\nLet me know if you need anything else.`,
      stopReason: "end_turn",
      truncated: false,
    })
    const r = await triageEmailLead("s", "b")
    expect(r?.temperature).toBe("warm")
  })
})

// 2026-10-13 — mailed-record matching. autoLinkMailRecord keys on
// leads.property_address; the email path never extracted one, so the NOO Q4
// smoke-test email ("got your letter about 4032 Ross Park Ct") stayed
// Unmatched. Pins the parse: trimmed string through, junk → null.
describe("triageEmailLead property_address", () => {
  it("passes a stated address through, trimmed", async () => {
    ok({ ...BASE, property_address: "  4032 Ross Park Ct, San Jose  " })
    const r = await triageEmailLead("Your letter", "I got your letter about 4032 Ross Park Ct in San Jose.")
    expect(r?.property_address).toBe("4032 Ross Park Ct, San Jose")
  })
  it("is null when the model returns null, blank, or a non-string", async () => {
    for (const v of [null, "", "   ", 42, { street: "x" }]) {
      ok({ ...BASE, property_address: v })
      const r = await triageEmailLead("Re: letter", "Not interested, thanks.")
      expect(r?.property_address).toBeNull()
    }
  })
})

// 2026-10-21 — the validator keeps what it got. Seen live on the NOO Q4
// probe emails: the model (correctly) returned `suggestedReply: null` for a
// "please ignore" mail and the whole triage was dropped — no summary, no
// property_address, no moment on the card, and nothing in the logs. Null is
// now reserved for a thrown call / no JSON object, and both alert Telegram.
const PROBE = {
  temperature: "cold",
  is_dead: false,
  summary: "Test probe from the mail house asking Ryan to ignore this message.",
  suggestedReply: null,
  offer_amount: null,
  offer_verbalized: false,
  recommended_followup_date: null,
  followup_reason: null,
  moment: "junk_wrong_person",
  property_address: "4032 Ross Park Ct, San Jose",
}

describe("triageEmailLead keeps valid fields and defaults the rest", () => {
  it("probe JSON: suggestedReply null → \"\", address + summary + moment survive", async () => {
    ok(PROBE)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const r = await triageEmailLead("Please ignore", "This is a probe from the mail house — please ignore.")
    expect(r).not.toBeNull()
    expect(r?.property_address).toBe("4032 Ross Park Ct, San Jose")
    expect(r?.summary).toBe(PROBE.summary)
    expect(r?.temperature).toBe("cold")
    expect(r?.moment).toBe("junk_wrong_person")
    expect(r?.suggestedReply).toBe("")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[triage-email] field defaulted"), expect.any(String))
    warn.mockRestore()
  })

  it("off-list temperature → cold, everything else kept", async () => {
    ok({ ...PROBE, temperature: "lukewarm", suggestedReply: "Thanks — what's your timeline?" })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const r = await triageEmailLead("s", "b")
    expect(r?.temperature).toBe("cold")
    expect(r?.property_address).toBe("4032 Ross Park Ct, San Jose")
    expect(r?.suggestedReply).toBe("Thanks — what's your timeline?")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('temperature="lukewarm"'), expect.any(String))
    warn.mockRestore()
  })

  it("missing summary → first 160 chars of the body", async () => {
    ok({ ...PROBE, summary: null })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const body = "x".repeat(300)
    const r = await triageEmailLead("s", body)
    expect(r?.summary).toBe("x".repeat(160))
    expect(r?.property_address).toBe("4032 Ross Park Ct, San Jose")
    vi.mocked(console.warn).mockRestore()
  })

  it("off-list moment → null without dropping the result", async () => {
    ok({ ...PROBE, moment: "excited" })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const r = await triageEmailLead("s", "b")
    expect(r).not.toBeNull()
    expect(r?.moment).toBeNull()
    vi.mocked(console.warn).mockRestore()
  })

  it("a thrown model call → null AND a Telegram alert naming the sender", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "t")
    vi.stubEnv("TELEGRAM_CHAT_ID", "c")
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    model.mockRejectedValue(new Error("overloaded"))
    const r = await triageEmailLead("Your letter", "body", { sender: "seller@example.com" })
    expect(r).toBeNull()
    const call = fetchSpy.mock.calls.find(([url]) => String(url).includes("api.telegram.org"))
    expect(call).toBeTruthy()
    const body = JSON.parse(String((call?.[1] as RequestInit).body))
    expect(body.text).toContain("Email triage failed")
    expect(body.text).toContain("seller@example.com")
    fetchSpy.mockRestore()
    err.mockRestore()
  })

  it("no JSON object in the response → null AND a Telegram alert", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "t")
    vi.stubEnv("TELEGRAM_CHAT_ID", "c")
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    model.mockResolvedValue({ text: "I cannot triage this email.", stopReason: "end_turn", truncated: false })
    const r = await triageEmailLead("s", "b", { sender: "+14085551212" })
    expect(r).toBeNull()
    expect(err).toHaveBeenCalledWith(expect.stringContaining("[triage-email] Threw"), expect.any(String), "raw:", expect.stringContaining("I cannot triage"))
    const call = fetchSpy.mock.calls.find(([url]) => String(url).includes("api.telegram.org"))
    expect(JSON.parse(String((call?.[1] as RequestInit).body)).text).toContain("+14085551212")
    fetchSpy.mockRestore()
    err.mockRestore()
  })
})

describe("analyzeCallTranscript keeps valid fields and defaults the rest", () => {
  it("off-list temperature + missing summary → cold + transcript head; address and name survive", async () => {
    ok({
      temperature: "lukewarm",
      summary: "",
      name: "Brian",
      property_address: "2127 Los Gatos Almaden Rd",
      email: null,
      recommended_followup_date: null,
      followup_reason: null,
      is_dnc: false,
      offer_amount: null,
      offer_verbalized: false,
      property_details: [],
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const transcript = "Hi this is Brian calling about the duplex at 2127 Los Gatos Almaden Rd, give me a call back."
    const r = await analyzeCallTranscript(transcript)
    expect(r).not.toBeNull()
    expect(r?.temperature).toBe("cold")
    expect(r?.summary).toBe(transcript.slice(0, 160))
    expect(r?.name).toBe("Brian")
    expect(r?.property_address).toBe("2127 Los Gatos Almaden Rd")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[analyze-call] field defaulted"), expect.any(String))
    warn.mockRestore()
  })
})
