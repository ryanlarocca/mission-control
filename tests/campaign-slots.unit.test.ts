import { describe, it, expect } from "vitest"
import { isStaleSlot, ensureFreshSlot, respreadSlot, randomSendSlot } from "../lib/campaignSlots"
import * as gatesModule from "../scripts/campaign-gates.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { windowStartIso, nextWeekdaySlot } = gatesModule as unknown as Record<string, any>

const PT = "America/Los_Angeles"
const ptOf = (iso: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, minute: (Number(p.hour) % 24) * 60 + Number(p.minute) }
}
// Tue 2026-10-14 18:18 PT = 2026-10-15T01:18:00Z (PDT, UTC-7) — the approval that produced zero sends.
const lateTuesday = new Date("2026-10-15T01:18:00Z")
// Wed 2026-10-15 07:05 PT — the first engine pass of the next morning.
const wedMorning = new Date("2026-10-15T14:05:00Z")
// Wed 2026-10-15 14:00 PT
const wedAfternoon = new Date("2026-10-15T21:00:00Z")
// Fri 2026-10-16 18:00 PT
const lateFriday = new Date("2026-10-17T01:00:00Z")

describe("Task 8 — respread late approvals", () => {
  it("a slot before today's 07:00 PT is stale; today's and future slots are not; null never is", () => {
    expect(windowStartIso(wedMorning)).toBe("2026-10-15T14:00:00.000Z")
    expect(isStaleSlot("2026-10-14T21:30:00Z", wedMorning)).toBe(true) // Tue 2:30 PM PT
    expect(isStaleSlot("2026-10-15T13:59:00Z", wedMorning)).toBe(true) // Wed 6:59 AM PT
    expect(isStaleSlot("2026-10-15T14:00:00Z", wedMorning)).toBe(false) // Wed 7:00 AM PT exactly
    expect(isStaleSlot("2026-10-15T20:00:00Z", wedMorning)).toBe(false)
    expect(isStaleSlot(null, wedMorning)).toBe(false)
    expect(isStaleSlot(undefined, wedMorning)).toBe(false)
  })

  it("approved after the window → a random minute in the NEXT weekday's window", () => {
    for (let i = 0; i < 50; i++) {
      const slot = respreadSlot(lateTuesday)!
      const p = ptOf(slot)
      expect(p.day).toBe("2026-10-15")
      expect(p.minute).toBeGreaterThanOrEqual(7 * 60)
      expect(p.minute).toBeLessThanOrEqual(16 * 60 + 59)
    }
    const fri = ptOf(respreadSlot(lateFriday)!)
    expect(fri.day).toBe("2026-10-19") // Monday
    expect(fri.weekday).toBe("Mon")
  })

  it("the morning safety net spreads stale rows over the rest of today's window, never a 7:00–7:20 burst", () => {
    const minutes = new Set<number>()
    for (let i = 0; i < 200; i++) {
      const p = ptOf(respreadSlot(wedMorning)!)
      expect(p.day).toBe("2026-10-15")
      expect(p.minute).toBeGreaterThan(7 * 60 + 5)
      expect(p.minute).toBeLessThanOrEqual(16 * 60 + 59)
      minutes.add(p.minute)
    }
    expect(minutes.size).toBeGreaterThan(50)
    const pm = ptOf(respreadSlot(wedAfternoon)!)
    expect(pm.day).toBe("2026-10-15")
    expect(pm.minute).toBeGreaterThan(14 * 60)
  })

  it("ensureFreshSlot keeps a future slot, respreads a stale or past one, leaves null alone", () => {
    expect(ensureFreshSlot("2026-10-16T17:30:00Z", wedMorning)).toBe("2026-10-16T17:30:00Z")
    expect(ensureFreshSlot(null, wedMorning)).toBeNull()
    const stale = ensureFreshSlot("2026-10-14T21:30:00Z", wedMorning)!
    expect(stale).not.toBe("2026-10-14T21:30:00Z")
    expect(ptOf(stale).day).toBe("2026-10-15")
    // past today, inside the window → later today
    const past = ensureFreshSlot("2026-10-15T20:00:00Z", wedAfternoon)!
    expect(new Date(past).getTime()).toBeGreaterThan(wedAfternoon.getTime())
    expect(ptOf(past).day).toBe("2026-10-15")
    // garbage → a fresh slot rather than a crash
    expect(ptOf(ensureFreshSlot("not a date", wedMorning)!).day).toBe("2026-10-15")
    // the experiment slot (next weekday) is never stale, so the approve paths leave it alone
    const exp = randomSendSlot(lateTuesday)!
    expect(ensureFreshSlot(exp, lateTuesday)).toBe(exp)
    expect(ptOf(nextWeekdaySlot(lateFriday)).weekday).toBe("Mon")
  })
})
