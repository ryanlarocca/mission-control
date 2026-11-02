import { describe, it, expect } from "vitest"
import {
  computeLadder,
  firstText,
  isBusinessHours,
  justTriedText,
  nextMorningAt,
  nextOpenAt,
  pacificDate,
  streetLabel,
  type LadderRow,
} from "@/lib/websiteLead"
import { pickCampaignType, DRIP_CAMPAIGNS } from "@/lib/drip-campaigns"

// Website leads are call-first (2026-11-02): three call attempts — right
// away, ~2h later, next morning — in business hours 8am–7pm Pacific, every
// day. Maryam Norton's form sat with no call and no Telegram ping.

const FORM = { id: "form", created_at: "2026-11-02T18:11:54Z" } // 10:11am PST
const call = (id: string, at: string, extra: Partial<LadderRow> = {}): LadderRow => ({
  id, created_at: at, twilio_number: null, lead_type: "call", call_conversation: false, ...extra,
})

describe("business hours (Pacific)", () => {
  it("8am–7pm is open, every day", () => {
    expect(isBusinessHours(new Date("2026-11-02T18:00:00Z"))).toBe(true) // 10am PST Mon
    expect(isBusinessHours(new Date("2026-11-08T17:00:00Z"))).toBe(true) // 9am PST Sun
    expect(isBusinessHours(new Date("2026-11-03T03:30:00Z"))).toBe(false) // 7:30pm PST
    expect(isBusinessHours(new Date("2026-11-02T15:30:00Z"))).toBe(false) // 7:30am PST
  })
  it("after hours rolls to 8am the next morning; early morning to 8am today", () => {
    expect(nextOpenAt(new Date("2026-11-03T04:00:00Z")).toISOString()).toBe("2026-11-03T16:00:00.000Z") // 8pm → 8am
    expect(nextOpenAt(new Date("2026-11-02T13:00:00Z")).toISOString()).toBe("2026-11-02T16:00:00.000Z") // 5am → 8am
  })
  it("handles daylight time (PDT is UTC-7)", () => {
    expect(nextOpenAt(new Date("2026-07-01T04:00:00Z")).toISOString()).toBe("2026-07-01T15:00:00.000Z") // 9pm PDT → 8am PDT
    expect(nextMorningAt(new Date("2026-07-01T18:00:00Z")).toISOString()).toBe("2026-07-02T16:00:00.000Z") // → 9am PDT next day
  })
  it("next morning is 9am the following day", () => {
    expect(nextMorningAt(new Date("2026-11-02T20:10:00Z")).toISOString()).toBe("2026-11-03T17:00:00.000Z")
    expect(pacificDate(new Date("2026-11-03T05:00:00Z"))).toBe("2026-11-02") // 9pm PST still the 2nd
  })
})

describe("computeLadder", () => {
  it("fresh form → attempt 1 due right away (in hours)", () => {
    const s = computeLadder(FORM, [{ id: "form", created_at: FORM.created_at, twilio_number: "+16506703914", lead_type: "form" }])
    expect(s).toMatchObject({ phase: "calling", attempt: 1, callsMade: 0 })
    if (s.phase === "calling") expect(s.dueAt.toISOString()).toBe("2026-11-02T18:11:54.000Z")
  })
  it("one missed call → attempt 2 two hours later", () => {
    const s = computeLadder(FORM, [call("c1", "2026-11-02T20:10:00Z")])
    expect(s).toMatchObject({ phase: "calling", attempt: 2, callsMade: 1 })
    if (s.phase === "calling") expect(s.dueAt.toISOString()).toBe("2026-11-02T22:10:00.000Z")
  })
  it("attempt 2 that would land after 7pm waits for 8am", () => {
    const s = computeLadder(FORM, [call("c1", "2026-11-03T02:30:00Z")]) // 6:30pm PST
    if (s.phase !== "calling") throw new Error(s.phase)
    expect(s.dueAt.toISOString()).toBe("2026-11-03T16:00:00.000Z")
  })
  it("two missed calls → attempt 3 next morning at 9", () => {
    const s = computeLadder(FORM, [call("c1", "2026-11-02T18:20:00Z"), call("c2", "2026-11-02T20:30:00Z")])
    expect(s).toMatchObject({ phase: "calling", attempt: 3 })
    if (s.phase === "calling") expect(s.dueAt.toISOString()).toBe("2026-11-03T17:00:00.000Z")
  })
  it("three missed calls → unreached (drip)", () => {
    const s = computeLadder(FORM, [call("c1", "2026-11-02T18:20:00Z"), call("c2", "2026-11-02T20:30:00Z"), call("c3", "2026-11-03T17:05:00Z")])
    expect(s).toEqual({ phase: "unreached", callsMade: 3 })
  })
  it("a conversation ends the ladder", () => {
    expect(computeLadder(FORM, [call("c1", "2026-11-02T18:20:00Z", { call_conversation: true })])).toEqual({ phase: "connected", settled: true })
  })
  it("a long call awaiting its transcript holds, then counts as connected after 30 min", () => {
    const rows = [call("c1", "2026-11-02T18:20:00Z", { call_conversation: null, call_duration_sec: 240 })]
    expect(computeLadder(FORM, rows, new Date("2026-11-02T18:30:00Z"))).toEqual({ phase: "connected", settled: false })
    expect(computeLadder(FORM, rows, new Date("2026-11-02T19:00:00Z"))).toEqual({ phase: "connected", settled: true })
  })
  it("a call where Ryan's own cell never answered isn't an attempt", () => {
    const s = computeLadder(FORM, [call("c1", "2026-11-02T18:20:00Z", { call_conversation: null, call_duration_sec: null })])
    expect(s).toMatchObject({ phase: "calling", attempt: 1 })
  })
  it("the lead calling or texting back ends the ladder", () => {
    const back = { id: "in", created_at: "2026-11-02T19:00:00Z", twilio_number: "+16506703914", lead_type: "voicemail" }
    expect(computeLadder(FORM, [back])).toEqual({ phase: "engaged" })
  })
  it("our own texts and emails don't count as engagement or attempts", () => {
    const rows: LadderRow[] = [
      { id: "t", created_at: "2026-11-02T18:12:00Z", twilio_number: null, lead_type: "sms" },
      { id: "e", created_at: "2026-11-02T18:12:00Z", twilio_number: null, lead_type: "email" },
    ]
    expect(computeLadder(FORM, rows)).toMatchObject({ phase: "calling", attempt: 1 })
  })
  it("rows before the form are ignored", () => {
    expect(computeLadder(FORM, [call("old", "2026-10-01T18:00:00Z", { call_conversation: true })])).toMatchObject({ phase: "calling", attempt: 1 })
  })
})

describe("copy", () => {
  it("first text promises a call, after hours tomorrow", () => {
    expect(firstText({ name: "maryam norton", address: "5122 Severance Ct, San Jose, CA", inHours: true }))
      .toBe("Hi Maryam, it's Ryan with LRG Homes. Got your note about Severance Ct. I'll give you a call in the next few minutes.")
    expect(firstText({ name: "", address: null, inHours: false })).toContain("first thing tomorrow morning")
  })
  it("just-tried text gives the Website line", () => {
    expect(justTriedText("Maryam Norton")).toBe("Hi Maryam, it's Ryan with LRG Homes. Just tried you. Call or text me back at (650) 670-3914 whenever works.")
  })
  it("street label strips the house number", () => {
    expect(streetLabel("5122 Severance Ct, San Jose, CA")).toBe("Severance Ct")
    expect(streetLabel(null)).toBeNull()
  })
})

describe("website follow-up drip", () => {
  it("Apply Drip on a website lead picks the short website cadence", () => {
    expect(pickCampaignType({ caller_phone: "+16505207069", email: null, source: "Website" })).toBe("website_followup")
    expect(pickCampaignType({ caller_phone: null, email: "a@b.com", source: "Website" })).toBe("website_followup_email")
  })
  it("4 touches over two weeks", () => {
    const t = DRIP_CAMPAIGNS.website_followup.touches
    expect(t.length).toBe(4)
    expect(t.reduce((n, x) => n + x.delayHours, 0)).toBe(14 * 24) // last touch lands on day 14
    expect(DRIP_CAMPAIGNS.website_followup_email.touches.every((x) => x.channel === "email")).toBe(true)
  })
})
