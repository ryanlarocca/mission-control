import { describe, it, expect } from "vitest"
import { configDials } from "@/lib/marketCycle/config"
import { DISPLAY, GROUP_ORDER } from "@/lib/marketCycle/display"
import { dateLabel, formatValue, last12Months, previousReading, timelineX, trend, vsNormal, vsPeak, yearOverYear } from "@/lib/marketCycle/view"
import type { Reading } from "@/lib/marketCycle/types"

const r = (dial_id: string, as_of: string, value: number | null): Reading => ({ dial_id, as_of, value, source_url: "x", raw: null })
const dials = configDials()
const dial = (id: string) => dials.find((d) => d.id === id)!

describe("/cycle view model", () => {
  it("every chart is 12 months ending at the newest reading, one point per month, letters underneath", () => {
    const daily = Array.from({ length: 400 }, (_, i) => r("sp500", new Date(Date.UTC(2025, 9, 1) + i * 86_400_000).toISOString().slice(0, 10), 7000 + i))
    const s = last12Months(daily)
    expect(s).toHaveLength(12)
    expect(s.map((x) => x.letter).join("")).toBe("DJFMAMJJASON")
    expect(s[11].value).toBe(7399) // the month's last reading
    const quarterly = [r("gdp", "2026-01-01", 1), r("gdp", "2026-04-01", 2), r("gdp", "2026-07-01", 3)]
    expect(last12Months(quarterly).filter((x) => x.value !== null)).toHaveLength(3) // gaps stay gaps
  })

  it("'previous' is a real period back: a re-run the next day is not last week", () => {
    const w = dial("mls_scc_active_sfr")
    expect(previousReading(w, [r(w.id, "2026-11-01", 1165), r(w.id, "2026-11-02", 1160)])).toBeNull()
    expect(previousReading(w, [r(w.id, "2026-11-02", 1160), r(w.id, "2026-11-09", 1190)])).toEqual({ as_of: "2026-11-02", value: 1160 })
  })

  it("arrow = direction; colour = what it means for SCC house prices; context is always gray", () => {
    const m = dial("mortgage30")
    expect(trend(m, [r(m.id, "2026-10-29", 7.24), r(m.id, "2026-11-05", 7.18)], "pct")).toMatchObject({ arrow: "▼", tone: "good" })
    const inv = dial("realtor_active_scc")
    expect(trend(inv, [r(inv.id, "2026-09-01", 1800), r(inv.id, "2026-10-01", 1970)], "int")).toMatchObject({ arrow: "▲", tone: "bad" })
    expect(trend(inv, [r(inv.id, "2026-09-01", 1965), r(inv.id, "2026-10-01", 1970)], "int")).toMatchObject({ arrow: "▬", tone: "flat" })
    const condo = dial("zhvi_scc_condo_yoy")
    expect(trend(condo, [r(condo.id, "2026-08-31", -3.79), r(condo.id, "2026-09-30", -3.85)], "pct_signed", true).tone).toBe("flat")
  })

  it("change numbers are coloured by the number itself (Ryan: a drop from the peak is red, even when it improved)", () => {
    const dd = dial("zhvi_scc_drawdown")
    expect(trend(dd, [r(dd.id, "2026-08-31", -3.761), r(dd.id, "2026-09-30", -3.357)], "pct_signed")).toMatchObject({ arrow: "▲", tone: "bad" })
    const low = dial("zhvi_scc_bottom_yoy")
    expect(trend(low, [r(low.id, "2026-08-31", -0.281), r(low.id, "2026-09-30", -0.189)], "pct_signed")).toMatchObject({ arrow: "▲", tone: "bad" })
    const top = dial("zhvi_scc_top_yoy")
    expect(trend(top, [r(top.id, "2026-08-31", 3.542), r(top.id, "2026-09-30", 3.542)], "pct_signed")).toMatchObject({ arrow: "▬", tone: "good" })
  })

  it("the page shows single-family numbers only (no Realtor.com all-types rows)", () => {
    expect(Object.keys(DISPLAY).filter((id) => id.startsWith("realtor_"))).toEqual([])
    expect(DISPLAY.mls_scc_price_cut_share.key).toBe(3)
    expect(DISPLAY.mls_scc_pending_ratio.key).toBe(4)
  })

  it("formats read like a person wrote them", () => {
    expect(formatValue(-3.357, "pct_signed")).toBe("−3.4%")
    expect(formatValue(7.18, "pct")).toBe("7.18%")
    expect(formatValue(1717141, "usd")).toBe("$1,717,141")
    expect(formatValue(7688.62, "int")).toBe("7,689")
    expect(dateLabel("2026-09-30", "monthly")).toBe("Sep 2026")
    expect(dateLabel("2026-11-04", "daily")).toBe("Nov 4")
  })

  it("'about 50% above a normal October' from the seasonal band", () => {
    const d = { ...dial("realtor_active_scc"), corridor: { computed: { by_month: { "10": { mean: 1316, sd: 215, n: 5 } } } } }
    expect(vsNormal(d, [r(d.id, "2026-10-01", 1970)])).toBe("about 50% above a normal October (usual range 1,101–1,531)")
  })

  it("vs last year and vs peak (the stored all-time high wins over the loaded window)", () => {
    const rows = [r("z", "2025-09-30", 1_655_168), r("z", "2026-09-30", 1_741_819)]
    expect(yearOverYear(rows)).toBeCloseTo(5.24, 1)
    expect(vsPeak(rows, { as_of: "2022-06-30", value: 1_786_356 })).toEqual({ pct: expect.closeTo(-2.49, 1), month: "Jun 2022" })
  })

  it("timeline spans Oct 2026 – Dec 2028", () => {
    expect(timelineX("2026-10", "start")).toBe(0)
    expect(timelineX("2028-12", "end")).toBe(1)
  })

  it("every displayed dial exists and sits in a known group; 9 key numbers", () => {
    const ids = new Set(dials.map((d) => d.id))
    for (const [id, d] of Object.entries(DISPLAY)) {
      expect(ids.has(id), id).toBe(true)
      expect(GROUP_ORDER).toContain(d.group)
    }
    expect(Object.values(DISPLAY).filter((d) => d.key).map((d) => d.key).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})
