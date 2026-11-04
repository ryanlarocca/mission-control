import { describe, expect, it } from "vitest"
import { NO_HISTORY, decideArm, returningCallerNote, spokenAddress, type CallerHistory } from "@/lib/jackie"
import { JACKIE_LINES } from "@/lib/leads"

// Ryan 2026-11-03: no coin flip — Jackie takes every missed call on the
// mailer lines, returning callers included, with the voicemail exceptions.
const base = { answered: false, anonymous: false, anonymousJackieToday: 0, jackieToday: 0, forced: false, history: NO_HISTORY }
const gary: CallerHistory = { prior: { name: "Gary", property_address: "140 Johnson Ave, Los Gatos, CA 95030" }, relationship: false, iphone: true, dnc: false }

describe("decideArm", () => {
  it("first-time missed caller → Jackie, every time (no coin)", () => {
    expect(decideArm(base)).toEqual({ arm: "jackie", jackie: true, reason: "first-time caller" })
  })
  it("returning missed caller → Jackie with the returning arm", () => {
    expect(decideArm({ ...base, history: gary })).toMatchObject({ arm: "returning", jackie: true, reason: "returning caller" })
  })
  it("Ryan answered → nobody else", () => {
    expect(decideArm({ ...base, answered: true })).toMatchObject({ arm: "answered", jackie: false })
    expect(decideArm({ ...base, answered: true, history: gary })).toMatchObject({ arm: "returning", jackie: false })
  })
  it("Relationships contact → voicemail", () => {
    expect(decideArm({ ...base, history: { ...gary, relationship: true } })).toMatchObject({ jackie: false, reason: "Relationships contact" })
  })
  it("asked off the list → voicemail", () => {
    expect(decideArm({ ...base, history: { ...gary, dnc: true } })).toMatchObject({ jackie: false, reason: "asked to come off the list" })
  })
  it("only in the iPhone log, no card → voicemail", () => {
    expect(decideArm({ ...base, history: { ...NO_HISTORY, iphone: true } })).toMatchObject({ arm: "returning", jackie: false })
  })
  it("3 Jackie calls from this number today → voicemail", () => {
    expect(decideArm({ ...base, history: gary, jackieToday: 2 }).jackie).toBe(true)
    expect(decideArm({ ...base, history: gary, jackieToday: 3 }).jackie).toBe(false)
  })
  it("withheld numbers: no history, shared daily cap", () => {
    expect(decideArm({ ...base, anonymous: true, history: gary })).toMatchObject({ arm: "jackie", jackie: true })
    expect(decideArm({ ...base, anonymous: true, anonymousJackieToday: 3 })).toMatchObject({ arm: null, jackie: false })
  })
  it("test number → Jackie unless answered, never scored", () => {
    expect(decideArm({ ...base, forced: true, history: { ...gary, relationship: true } })).toEqual({ arm: null, jackie: true, reason: "test number" })
  })
})

describe("returning caller note", () => {
  it("says the property the way a person would and checks it rather than assuming", () => {
    const n = returningCallerNote({ name: "Gary", property_address: "140 Johnson Ave, Los Gatos, CA 95030" })
    expect(n).toContain("name Gary, property 140 Johnson Ave, Los Gatos.")
    expect(n).toContain("don't greet them by name")
    expect(n).not.toContain("95030")
  })
  it("no address on file → the address is still her top priority", () => {
    expect(returningCallerNote({ name: null, property_address: null })).toContain("Getting the property address is still your top priority")
  })
  it("spokenAddress drops state + zip only", () => {
    expect(spokenAddress("140 Johnson Ave, Los Gatos, CA 95030")).toBe("140 Johnson Ave, Los Gatos")
    expect(spokenAddress("860 24th Ave, Santa Cruz 95062")).toBe("860 24th Ave, Santa Cruz")
    expect(spokenAddress("12 Camino Real, San Mateo")).toBe("12 Camino Real, San Mateo")
  })
})

describe("JACKIE_LINES", () => {
  it("covers the mailer lines, not the test, website, outbound, office or agents lines", () => {
    expect(JACKIE_LINES.size).toBe(8)
    for (const n of ["+14083372785", "+16506703914", "+16502043247", "+14084585442", "+14084930632", "+16509104007"]) {
      expect(JACKIE_LINES.has(n)).toBe(false)
    }
  })
})
