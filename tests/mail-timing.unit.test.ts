import { describe, expect, it } from "vitest"
import { fmtBatch, fmtDays, weeklySeries, weeklyText } from "@/lib/mailTiming"

// Direct-mail response timing helpers (briefs/BRIEF_CLOUD_BATCH_2026-10-12.md
// Task 2). The SQL function hands back a sparse {"week": n} object; the panel
// needs a dense, ordered series so bars line up across batches.

describe("weeklySeries", () => {
  it("returns an empty series for an empty / missing histogram (no arrival dates yet)", () => {
    expect(weeklySeries({})).toEqual([])
    expect(weeklySeries(null)).toEqual([])
    expect(weeklySeries(undefined)).toEqual([])
  })

  it("fills gaps with zeros and orders by week", () => {
    expect(weeklySeries({ "2": 1, "0": 3 })).toEqual([
      { week: 0, n: 3 },
      { week: 1, n: 0 },
      { week: 2, n: 1 },
    ])
  })

  it("always starts at week 0 even when the first responder is later", () => {
    expect(weeklySeries({ "3": 2 })).toEqual([
      { week: 0, n: 0 },
      { week: 1, n: 0 },
      { week: 2, n: 0 },
      { week: 3, n: 2 },
    ])
  })

  it("keeps negative weeks (lead logged before the arrival date) ahead of week 0", () => {
    expect(weeklySeries({ "-1": 1, "0": 4 })).toEqual([
      { week: -1, n: 1 },
      { week: 0, n: 4 },
    ])
  })

  it("coerces numeric strings and ignores junk keys", () => {
    expect(weeklySeries({ "0": "2" as unknown as number, "1.5": 9, abc: 4, "1": 1 })).toEqual([
      { week: 0, n: 2 },
      { week: 1, n: 1 },
    ])
  })
})

describe("weeklyText", () => {
  it("renders a dash when there is nothing to show", () => {
    expect(weeklyText({})).toBe("—")
  })

  it("renders the dense series compactly", () => {
    expect(weeklyText({ "0": 3, "2": 1 })).toBe("w0 3 · w1 0 · w2 1")
  })
})

describe("fmtDays / fmtBatch", () => {
  it("shows a dash for null percentiles (no arrival date yet)", () => {
    expect(fmtDays(null)).toBe("—")
    expect(fmtDays(undefined)).toBe("—")
    expect(fmtDays("not a number")).toBe("—")
  })

  it("drops the decimal on whole days and keeps one otherwise", () => {
    expect(fmtDays(12)).toBe("12")
    expect(fmtDays("12.0")).toBe("12")
    expect(fmtDays(12.5)).toBe("12.5")
    expect(fmtDays("7.25")).toBe("7.3")
  })

  it("labels a null batch with a dash", () => {
    expect(fmtBatch(null)).toBe("—")
    expect(fmtBatch(2)).toBe("2")
  })
})
