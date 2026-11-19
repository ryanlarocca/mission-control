import { describe, it, expect } from "vitest"
import { BETS, configDials } from "@/lib/marketCycle/config"
import { alarmLine, asOfLabel, betSigns, checkedStamp, latestGroups, priceCutNote, signLine } from "@/lib/marketCycle/latest"
import type { DialVote, Reading, VoteKind } from "@/lib/marketCycle/types"

const r = (dial_id: string, as_of: string, value: number | null, extra: Partial<Reading> = {}): Reading => ({ dial_id, as_of, value, source_url: "x", raw: null, ...extra })
const dials = configDials()
const dial = (id: string) => dials.find((d) => d.id === id)!
const vote = (dial_id: string, v: VoteKind, value: number, as_of = "2026-10-31", leaning: VoteKind | null = v): DialVote => ({
  dial_id,
  name: dial_id,
  category: dial(dial_id).category,
  vote: v,
  reading: { as_of, value },
  band: "",
  z: null,
  outside: null,
  leaning,
  persistent: v !== "none",
  reason: "",
})
const housing = BETS.find((b) => b.id === "housing")!
const spx = BETS.find((b) => b.id === "spx")!

describe("/cycle latest numbers", () => {
  it("freshness stamp: this morning, yesterday, and plainly stale past 36 hours (Pacific time)", () => {
    const now = new Date("2026-11-19T17:00:00Z") // 9:00 AM PT
    expect(checkedStamp("2026-11-19T14:31:07Z", now)).toEqual({ text: "Checked this morning 6:31 AM", stale: false })
    expect(checkedStamp("2026-11-18T14:31:07Z", now)).toEqual({ text: "Checked yesterday 6:31 AM", stale: false })
    const stale = checkedStamp("2026-11-17T14:31:07Z", now)
    expect(stale.stale).toBe(true)
    expect(stale.text).toBe("Last checked Tue, Nov 17, 2026 6:31 AM — the mini may be down")
    expect(checkedStamp(null, now).stale).toBe(true)
  })

  it("up/down = the review's own votes; 3 signs from 2 areas = enough to tilt at the next review", () => {
    const votes = [
      vote("zhvi_scc_top_yoy", "bull", 3.125),
      vote("sj_msa_nonfarm_yoy", "bull", 1.8, "2026-09-01"),
      vote("sj_rent_yoy", "bull", 7.925, "2026-10-01"),
      vote("realtor_price_reduced_share_scc", "bear", 32.5, "2026-10-01"),
      vote("car_scc_sfr_median", "none", 5.8, "2026-10-01", "bull"),
      vote("nasdaq", "bull", 1), // not a housing dial
    ]
    const s = betSigns(housing, votes, { dials, readings: {}, tripwireEvents: [] }, "Dec 21, 2026")
    expect(s.up.map((x) => x.text)).toEqual(["Top-tier home prices +3.1% vs a year ago", "San Jose jobs +1.8% vs a year ago", "San Jose rents +7.9% vs a year ago"])
    expect(s.up[0].when).toBe("Oct 2026")
    expect(s.down.map((x) => x.text)).toEqual(["33% of county listings have cut their price"])
    expect(s.leaningUp).toEqual(["County median sale price +5.8% vs a year ago"])
    expect(s.tilt).toBe("Enough to tilt the odds toward Bull at the Dec 21, 2026 review")

    // two bull dials from one area: not enough
    const few = betSigns(housing, votes.slice(0, 1).concat(vote("zhvi_scc_bottom_yoy", "bull", 2.5)), { dials, readings: {}, tripwireEvents: [] }, "Dec 21, 2026")
    expect(few.tilt).toMatch(/^Not enough to move the odds yet/)
    // a pending alarm lets the review move the odds anyway
    const alarm = betSigns(housing, [], { dials, readings: {}, tripwireEvents: [{ tripwire_id: "scc_warn_spike", dial_id: "scc_warn_workers", fired_on: "2026-11-18", reading: 2000, detail: null, review_requested: true, reviewed_at: null }] }, null)
    expect(alarm.tilt).toBe("An alarm went off — the odds can move at the next review")
  })

  it("stocks: the middle case counts separately, and the S&P drop reads in words", () => {
    const s = betSigns(spx, [vote("nasdaq", "base", -11.486, "2026-11-18"), vote("initial_claims_4wk", "bull", 197750, "2026-11-14")], { dials, readings: {}, tripwireEvents: [] }, "Dec 21, 2026")
    expect(s.middle.map((x) => x.text)).toEqual(["Nasdaq 11.5% below its Oct 6, 2026 high"])
    expect(s.middle[0].when).toBe("Nov 18, 2026")
    expect(s.up).toHaveLength(1)
  })

  it("seasonal dials say how far from a normal month they are — no z-scores", () => {
    const d = dial("realtor_active_scc")
    const hist = [2021, 2022, 2023, 2024, 2025].map((y, i) => r(d.id, `${y}-10-01`, [1100, 1300, 1200, 1400, 1500][i]))
    const line = signLine(vote(d.id, "bear", 1950, "2026-10-01"), { ...d, corridor: null }, [...hist, r(d.id, "2026-10-01", 1950)])
    expect(line).toBe("County listings 1,950, about 50% above a normal October")
    expect(line).not.toMatch(/σ|z=/)
  })

  it("groups by cadence, each number with its own date; weekly/monthly prints new this week are marked", () => {
    const readings: Record<string, Reading[]> = {
      sp500: [r("sp500", "2026-10-06", 7818.93), r("sp500", "2026-11-17", 7340.53), r("sp500", "2026-11-18", 7323.63)],
      mls_scc_active_sfr: [r("mls_scc_active_sfr", "2026-11-09", 1121, { created_at: "2026-11-09T14:08:00Z" }), r("mls_scc_active_sfr", "2026-11-16", 1097, { created_at: "2026-11-16T14:08:00Z" })],
      zhvi_scc_drawdown: [r("zhvi_scc_drawdown", "2026-09-30", -3.129, { created_at: "2026-10-16T14:31:00Z" }), r("zhvi_scc_drawdown", "2026-10-31", -2.772, { created_at: "2026-11-17T14:31:00Z" })],
      cpi_yoy: [r("cpi_yoy", "2026-09-01", 3.717, { created_at: "2026-10-24T14:31:00Z" })],
    }
    const g = latestGroups({ dials, readings }, "2026-11-19")
    expect(g.map((x) => x.cadence)).toEqual(["daily", "weekly", "monthly"])
    const sp = g[0].items[0]
    expect(sp).toMatchObject({ label: "S&P 500", value: "7,324", when: "Nov 18, 2026" })
    expect(sp.note).toMatch(/^6\.3% below its Oct 6, 2026 high/)
    expect(g[1].items[0]).toMatchObject({ value: "1,097", note: "was 1,121 last week", when: "Nov 16, 2026", fresh: true })
    const dd = g[2].items.find((x) => x.id === "zhvi_scc_drawdown")!
    expect(dd).toMatchObject({ value: "−2.8%", when: "Oct 2026", fresh: true, tone: "bad" })
    expect(g[2].items.find((x) => x.id === "cpi_yoy")).toMatchObject({ value: "3.7% a year", fresh: false })
  })

  it("price cuts: the week's count from the snapshot, not the change in a share that grows with our record", () => {
    const rows = [r("mls_scc_price_cut_share", "2026-11-02", 0), r("mls_scc_price_cut_share", "2026-11-16", 13.22, { raw: JSON.stringify({ cut_wow: 81, cut_first: 145 }) })]
    expect(priceCutNote(rows)).toBe("81 cut it this week · counting since Nov 2, 2026")
  })

  it("dates: monthly prints show month + year, daily/weekly show the day, always with the year", () => {
    expect(asOfLabel("2026-10-01", "monthly")).toBe("Oct 2026")
    expect(asOfLabel("2026-11-18", "daily")).toBe("Nov 18, 2026")
  })

  it("alarms: quiet with the last one, or what is waiting for a review", () => {
    const fired = { tripwire_id: "scc_actives_yoy", dial_id: "mls_scc_active_sfr", fired_on: "2026-11-02", reading: 45.8, detail: null, review_requested: true }
    expect(alarmLine({ tripwireEvents: [{ ...fired, reviewed_at: "2026-11-02T15:30:00Z" }] })).toEqual({ value: "Quiet", note: "none going off · last one Nov 2, 2026, reviewed", tone: "flat" })
    expect(alarmLine({ tripwireEvents: [{ ...fired, reviewed_at: null }] }).tone).toBe("bad")
  })
})
