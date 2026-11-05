import { describe, expect, it } from "vitest"
import { parseAnalyzedAppointment, pacificDayOf, pacificRfc3339 } from "@/lib/appointmentTime"
import { pickLeadForEvent, streetKey, type LeadCandidate } from "@/lib/appointments"
import { mergePropertyDetails } from "@/lib/leads"
import { chunkMonoWav, joinChunkResults, parseWavHeader } from "@/lib/coach/transcript"
import { callFacts, clipTranscript } from "@/lib/coach/rate"

// Made-up people and addresses throughout.

describe("analyzer appointment", () => {
  it("keeps a real day and time", () => {
    expect(parseAnalyzedAppointment({ date: "2026-11-06", time: "17:00", location: "12 Oak Dr", with: "Dana and Lee", about: "go over the sale" }))
      .toEqual({ date: "2026-11-06", time: "17:00", location: "12 Oak Dr", with: "Dana and Lee", about: "go over the sale" })
  })
  it("drops anything without both a day and a time", () => {
    expect(parseAnalyzedAppointment(null)).toBeNull()
    expect(parseAnalyzedAppointment({ date: "2026-11-06", time: null })).toBeNull()
    expect(parseAnalyzedAppointment({ date: "next week", time: "17:00" })).toBeNull()
    expect(parseAnalyzedAppointment({ date: "2026-11-06", time: "5pm" })).toBeNull()
  })
})

describe("Pacific wall clock", () => {
  it("uses standard time in November and daylight time in July", () => {
    expect(pacificRfc3339("2026-11-06", "17:00")).toBe("2026-11-06T17:00:00-08:00")
    expect(pacificRfc3339("2026-07-10", "09:30")).toBe("2026-07-10T09:30:00-07:00")
  })
  it("reads the Pacific day of an evening instant", () => {
    expect(pacificDayOf("2026-11-06T17:00:00-08:00")).toBe("2026-11-06")
    expect(pacificDayOf("2026-11-07T01:30:00Z")).toBe("2026-11-06")
  })
})

describe("Telegram event → lead", () => {
  const now = Date.parse("2026-11-05T18:00:00Z")
  const cand = (key: string, name: string, addresses: string[], daysAgo = 1): LeadCandidate => ({ key, leadId: key, name, addresses, newestAt: now - daysAgo * 86_400_000 })

  it("pulls the house number and street word", () => {
    expect(streetKey("265 Maple Court San Jose")).toEqual({ number: "265", street: "maple" })
    expect(streetKey("1130 N Suffolk Ct")).toEqual({ number: "1130", street: "suffolk" })
    expect(streetKey("the office")).toBeNull()
  })
  it("links by address even when the suffix is wrong", () => {
    const dana = cand("a", "Dana Reyes", ["261 Maple Dr, San Jose", "265 Maple Dr, San Jose"])
    const other = cand("b", "Dana Wu", ["9 Birch Ln, Fremont"])
    expect(pickLeadForEvent([dana, other], { person: "Dana", location: "265 Maple Court San Jose", summary: null }, now)).toBe(dana)
  })
  it("falls back to the street when the number is the seller's other house", () => {
    const dana = cand("a", "Dana Reyes", ["261 Maple Dr, San Jose"])
    expect(pickLeadForEvent([dana, cand("b", "Dana Wu", ["9 Birch Ln"])], { person: "Dana", location: "265 Maple Dr", summary: null }, now)).toBe(dana)
  })
  it("with no address match, links only a single recent lead of that name", () => {
    const recent = cand("a", "Dana Reyes", [], 3)
    const old = cand("b", "Dana Wu", [], 200)
    expect(pickLeadForEvent([recent, old], { person: "Dana", location: null, summary: "Lunch with Dana" }, now)).toBe(recent)
    expect(pickLeadForEvent([recent, cand("c", "Dana Wu", [], 5)], { person: "Dana", location: null, summary: null }, now)).toBeNull()
  })
  it("never guesses between two leads on the same street", () => {
    const a = cand("a", "Dana Reyes", ["265 Maple Dr"])
    const b = cand("b", "Dana Wu", ["265 Maple Ave"])
    expect(pickLeadForEvent([a, b], { person: "Dana", location: "265 Maple", summary: null }, now)).toBeNull()
  })
})

describe("property details merge", () => {
  const card = [{ label: "261 Maple Dr, San Jose, CA", occupancy: "Daughter lives there", year_built: "1998", notes: "Hand-entered note" }]
  it("ties a misheard street to the card's entry by house number", () => {
    const out = mergePropertyDetails(card, [{ label: "261 Mapel Drive", unit_mix: "3bd/2ba", occupancy: "Daughter and two others; nobody pays" }])
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe("261 Maple Dr, San Jose, CA")
    expect(out[0].unit_mix).toBe("3bd/2ba")
    // fill-only: what the card had stays
    expect(out[0].occupancy).toBe("Daughter lives there")
  })
  it("lets a live call update the card's facts but never the label", () => {
    const out = mergePropertyDetails(card, [{ label: "261 Mapel Drive", occupancy: "Daughter and two others; nobody pays" }], { preferIncoming: true })
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe("261 Maple Dr, San Jose, CA")
    expect(out[0].occupancy).toBe("Daughter and two others; nobody pays")
    expect(out[0].year_built).toBe("1998")
    expect(out[0].notes).toBe("Hand-entered note")
  })
  it("still appends a genuinely different house", () => {
    expect(mergePropertyDetails(card, [{ label: "265 Maple Dr", occupancy: "owner" }])).toHaveLength(2)
  })
})

describe("long recordings", () => {
  function monoWav(seconds: number, sampleRate = 8000): Buffer {
    const data = Buffer.alloc(seconds * sampleRate * 2)
    // Loud everywhere except one quiet second in the middle.
    for (let i = 0; i < data.length; i += 2) {
      const sec = i / 2 / sampleRate
      data.writeInt16LE(sec >= seconds / 2 + 2 && sec < seconds / 2 + 3 ? 0 : 8000, i)
    }
    const h = Buffer.alloc(44)
    h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8, "ascii")
    h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
    h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
    h.write("data", 36, "ascii"); h.writeUInt32LE(data.length, 40)
    return Buffer.concat([h, data])
  }

  it("leaves a short recording whole", () => {
    const wav = monoWav(10)
    const chunks = chunkMonoWav(wav, 1_000_000)!
    expect(chunks).toHaveLength(1)
    expect(chunks[0].offsetSec).toBe(0)
  })
  it("cuts a long one into valid WAVs at a quiet spot, losing nothing", () => {
    const wav = monoWav(60)
    const chunks = chunkMonoWav(wav, 500_000)!
    expect(chunks).toHaveLength(2)
    const infos = chunks.map((c) => parseWavHeader(c.wav)!)
    expect(infos.every((i) => i && i.channels === 1 && i.sampleRate === 8000)).toBe(true)
    expect(infos[0].dataLength + infos[1].dataLength).toBe(60 * 16000)
    // the cut lands inside the quiet second (32–33 s), not at the even split (30 s)
    expect(chunks[1].offsetSec).toBeGreaterThanOrEqual(32)
    expect(chunks[1].offsetSec).toBeLessThanOrEqual(33)
  })
  it("puts chunk timestamps back on the full recording's clock", () => {
    const joined = joinChunkResults([
      { offsetSec: 0, raw: { segments: [{ start: 0, end: 2, text: "hello" }], words: [{ word: "hello", start: 0.5, end: 1 }] } },
      { offsetSec: 900, raw: { segments: [{ start: 1, end: 3, text: "see you Friday" }], words: [{ word: "Friday", start: 2, end: 2.5 }] } },
    ])
    expect(joined.segments[1].start).toBe(901)
    expect(joined.words[1]).toEqual({ word: "Friday", start: 902, end: 902.5 })
  })
})

describe("coach inputs", () => {
  it("shows the whole of a normal long call, including its last minutes", () => {
    const t = "a".repeat(30_000) + " We could shoot for tomorrow at five."
    expect(clipTranscript(t)).toBe(t)
  })
  it("drops the middle, never the end, of an enormous one", () => {
    const t = "start " + "x".repeat(200_000) + " the meeting is set"
    const c = clipTranscript(t)
    expect(c.length).toBeLessThan(91_000)
    expect(c.startsWith("start ")).toBe(true)
    expect(c.endsWith("the meeting is set")).toBe(true)
  })
  it("states what the record shows", () => {
    const facts = callFacts({ appointment: { date: "2026-11-06", time: "17:00", location: "265 Maple Dr", with: "Dana and Lee" }, offer_verbalized: true, offer_amount: 950000, followup_reason: "Appointment: meet Dana Friday 5 PM" })
    expect(facts[0]).toContain("appointment was set")
    expect(facts[0]).toContain("2026-11-06 at 17:00")
    expect(facts[1]).toContain("$950,000")
    expect(callFacts(null)).toEqual([])
  })
})
