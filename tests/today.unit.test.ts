import { describe, expect, it } from "vitest"
import {
  apptWhen, clusterAppointments, dateLine, describeDue, describeJackieCall, greeting, lastNDays,
  monthStart, orderFollowUps, overnightWindow, pacificWallToUtc, shapeSpend, sumRollup,
  type ApptRow, type FollowUpRowLite,
} from "@/lib/today"
import type { NextTouch } from "@/lib/next-touch"

// Made-up people, numbers and addresses throughout.

describe("greeting by Pacific hour", () => {
  it("morning / afternoon / evening on Ryan's clock, not UTC", () => {
    // 2026-11-10 is PST (UTC−8).
    expect(greeting(new Date("2026-11-10T15:30:00Z"))).toBe("Morning, Ryan.")   // 7:30 AM
    expect(greeting(new Date("2026-11-10T19:59:00Z"))).toBe("Morning, Ryan.")   // 11:59 AM
    expect(greeting(new Date("2026-11-10T20:00:00Z"))).toBe("Afternoon, Ryan.") // 12:00 PM
    expect(greeting(new Date("2026-11-11T00:59:00Z"))).toBe("Afternoon, Ryan.") // 4:59 PM
    expect(greeting(new Date("2026-11-11T01:00:00Z"))).toBe("Evening, Ryan.")   // 5:00 PM
    expect(greeting(new Date("2026-11-10T10:00:00Z"))).toBe("Evening, Ryan.")   // 2:00 AM
  })
  it("date line carries the weekday and the year", () => {
    expect(dateLine(new Date("2026-11-10T18:00:00Z"))).toBe("Tuesday · Nov 10, 2026")
    // 7 PM Pacific on Nov 10 is already Nov 11 in UTC.
    expect(dateLine(new Date("2026-11-11T03:00:00Z"))).toBe("Tuesday · Nov 10, 2026")
  })
})

describe("Pacific overnight window", () => {
  it("starts at 5:00 PM Pacific the previous day (PST)", () => {
    const now = new Date("2026-11-10T16:00:00Z") // 8 AM Nov 10 PST
    const w = overnightWindow(now)
    expect(w.from.toISOString()).toBe("2026-11-10T01:00:00.000Z") // 5 PM Nov 9 PST
    expect(w.to).toBe(now)
    expect(w.prevFrom.toISOString()).toBe("2026-11-09T01:00:00.000Z")
    expect(w.prevTo.toISOString()).toBe("2026-11-09T16:00:00.000Z")
  })
  it("uses the daylight-time offset in summer", () => {
    const w = overnightWindow(new Date("2026-07-15T15:00:00Z")) // 8 AM PDT
    expect(w.from.toISOString()).toBe("2026-07-15T00:00:00.000Z") // 5 PM Jul 14 PDT
  })
  it("late evening still counts from yesterday 5 PM", () => {
    const w = overnightWindow(new Date("2026-11-11T05:00:00Z")) // 9 PM Nov 10 PST
    expect(w.from.toISOString()).toBe("2026-11-10T01:00:00.000Z")
  })
  it("Pacific midnight across the DST change", () => {
    expect(pacificWallToUtc("2026-11-01").toISOString()).toBe("2026-11-01T07:00:00.000Z") // still PDT at midnight
    expect(pacificWallToUtc("2026-11-02").toISOString()).toBe("2026-11-02T08:00:00.000Z") // PST
  })
})

describe("AI spend roll-up", () => {
  it("sums numeric strings from llm_usage_rollup", () => {
    expect(sumRollup([{ cost_usd: "1.250000" }, { cost_usd: 0.5 }, { cost_usd: null }])).toBeCloseTo(1.75)
    expect(sumRollup(null)).toBe(0)
  })
  it("7 Pacific days ending today, month start on the 1st", () => {
    const now = new Date("2026-11-10T18:00:00Z")
    const days = lastNDays(7, now)
    expect(days.map(d => d.ymd)).toEqual(["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"])
    expect(days[0].from.toISOString()).toBe("2026-11-04T08:00:00.000Z")
    expect(days[0].to.toISOString()).toBe("2026-11-05T08:00:00.000Z")
    expect(monthStart(now)).toEqual({ ymd: "2026-11-01", from: new Date("2026-11-01T07:00:00.000Z") })
  })
  it("shapes yesterday, month vs target, bars and labels", () => {
    const s = shapeSpend([
      { ymd: "2026-11-04", usd: 1 }, { ymd: "2026-11-05", usd: 4 }, { ymd: "2026-11-06", usd: 0 },
      { ymd: "2026-11-07", usd: 2 }, { ymd: "2026-11-08", usd: 0.02 }, { ymd: "2026-11-09", usd: 2.844 }, { ymd: "2026-11-10", usd: 1.5 },
    ], 41.2)
    expect(s.yesterdayUsd).toBe(2.84)
    expect(s.monthUsd).toBe(41.2)
    expect(s.monthPct).toBeCloseTo(41.2)
    expect(s.monthLabel).toBe("Nov")
    expect(s.bars).toEqual([25, 100, 0, 50, 4, 71, 38])
    expect(s.firstLabel).toBe("Nov 4, 2026")
    expect(s.lastLabel).toBe("Nov 10, 2026")
    expect(shapeSpend([{ ymd: "2026-11-10", usd: 0 }], 250).monthPct).toBe(100)
  })
})

describe("appointment clustering", () => {
  const base = (over: Partial<ApptRow>): ApptRow => ({
    id: "x", created_at: "2026-11-01T00:00:00Z", caller_phone: null, email: null, name: null,
    property_address: null, status: "active", is_dnc: false, is_junk: false,
    appointment_at: null, appointment_details: null, ...over,
  })
  it("one per person, newest row wins, dead/DNC dropped, window kept", () => {
    const rows: ApptRow[] = [
      base({ id: "a1", caller_phone: "+14085550101", created_at: "2026-11-01T00:00:00Z", name: "Pat Example", appointment_at: "2026-11-10T12:00:00Z", property_address: "12 Oak St, San Jose, CA" }),
      base({ id: "a2", caller_phone: "+14085550101", created_at: "2026-11-05T00:00:00Z", appointment_at: "2026-11-10T12:00:00Z",
        appointment_details: { start: "2026-11-10T14:00:00-08:00", location: "12 Oak St, San Jose", with: null, source: "call" } }),
      base({ id: "b1", caller_phone: "+14085550102", appointment_at: "2026-11-10T12:00:00Z", is_dnc: true }),
      base({ id: "c1", caller_phone: "+14085550103", appointment_at: "2026-11-11T12:00:00Z", status: "dead" }),
      base({ id: "d1", caller_phone: "+14085550104", name: "Lee Sample", appointment_at: "2026-11-12T12:00:00Z" }),
      base({ id: "e1", caller_phone: "+14085550105", appointment_at: "2026-11-30T12:00:00Z" }),
      base({ id: "f1", caller_phone: "+14085550106", name: "Early Bird", appointment_at: "2026-11-10T12:00:00Z",
        appointment_details: { start: "2026-11-10T09:30:00-08:00" } }),
    ]
    const out = clusterAppointments(rows, "2026-11-10", "2026-11-17")
    expect(out.map(a => a.key)).toEqual(["+14085550106", "+14085550101", "+14085550104"])
    expect(out[1].title).toBe("Pat Example · 12 Oak St")
    expect(out[1].sub).toBe("Booked from a call")
    expect(out[1].start).toBe("2026-11-10T22:00:00.000Z")
    const now = new Date("2026-11-10T16:00:00Z")
    expect(apptWhen(out[1], now)).toBe("2:00 PM")
    expect(apptWhen(out[2], now)).toBe("Nov 12, 2026")
  })
})

describe("Due today rows", () => {
  const call = (due: string, reason: string | null): NextTouch => ({
    kind: "call", due, reason, channel: "imessage", touchNumber: null, campaignType: null,
    isQueued: false, queueId: null, message: null, subject: null, stale: false,
  })
  const row = (over: Partial<FollowUpRowLite>): FollowUpRowLite => ({
    clusterKey: "k", name: null, phone: null, email: null, gmailThreadId: null, propertyAddress: null,
    temperature: null, primary: call("2026-11-10", null), ...over,
  })
  const now = new Date("2026-11-10T18:00:00Z")

  it("reads name, why and due state; deep-links the lead card", () => {
    const d = describeDue(row({ clusterKey: "a", name: "Pat Example", phone: "+14085550101", propertyAddress: "12 Oak St, San Jose", primary: call("2026-11-08", "Owed: comps on the duplex") }), now)
    expect(d).toMatchObject({ name: "Pat Example", why: "12 Oak St · comps on the duplex", when: "overdue 2d", tone: "overdue", href: "/leads?phone=%2B14085550101" })
    const t = describeDue(row({ clusterKey: "b", phone: "+14085550102", primary: call("2026-11-10", "Call back about the price") }), now)
    expect(t).toMatchObject({ name: "(408) 555-0102", when: "today", tone: "today" })
    const e = describeDue(row({ clusterKey: "c", email: "Someone@Example.com", gmailThreadId: null }), now)
    expect(e.href).toBe("/leads?phone=email%3Asomeone%40example.com")
  })

  it("orders like the worklist: replied, ready, overdue, then the rest", () => {
    const rows = [
      row({ clusterKey: "today-warm", temperature: "warm", primary: call("2026-11-10", null) }),
      row({ clusterKey: "overdue", primary: call("2026-11-01", null) }),
      row({ clusterKey: "today-hot", temperature: "hot", primary: call("2026-11-10", null) }),
      row({ clusterKey: "replied", replied: { at: "2026-11-10T10:00:00Z", kind: "sms", text: "hi" } }),
    ]
    expect(orderFollowUps(rows, now).map(r => r.clusterKey)).toEqual(["replied", "overdue", "today-hot", "today-warm"])
  })
})

describe("Jackie overnight lines", () => {
  it("formats the caller and what happened", () => {
    const j = describeJackieCall({
      id: "1", created_at: "2026-11-10T07:48:00Z", caller_phone: "+14085550111", name: null, call_arm: "jackie",
      property_address: "9 Elm Ct, San Jose", jackie_call: { duration_sec: 125, intake_complete: true, callback_when: "tomorrow at noon" },
    }, { "+14085550111": "Chris Example" })
    expect(j.title).toBe("Chris Example · first-time caller")
    expect(j.sub).toBe("call back tomorrow at noon · 9 Elm Ct · 2 min")
    const h = describeJackieCall({
      id: "2", created_at: "2026-11-10T14:02:00Z", caller_phone: "+16695550112", name: null, call_arm: "returning",
      property_address: null, jackie_call: { duration_sec: 8 },
    })
    expect(h.title).toBe("(669) 555-0112 · returning caller")
    expect(h.sub).toBe("Hung up · 0:08")
  })
})
