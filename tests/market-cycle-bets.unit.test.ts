import { describe, it, expect } from "vitest"
import { autoResolve, autoClaimUpdates } from "@/lib/marketCycle/autoclaims"
import { betClaims, betNow, betVotes, claimShort, tripwireApplies } from "@/lib/marketCycle/bets"
import { BETS, betById, claimAuto, configClaims, configDials } from "@/lib/marketCycle/config"
import { betWeightsFrom } from "@/lib/marketCycle/data"
import { computeVotes } from "@/lib/marketCycle/votes"
import type { AutoRule, Claim, Reading, WeightMove } from "@/lib/marketCycle/types"

const r = (dial_id: string, as_of: string, value: number): Reading => ({ dial_id, as_of, value, source_url: "x", raw: null })
const open = (id: string, resolves_on: string) => ({ id, resolves_on, status: "open" as const })
const dials = configDials()
const housing = betById("housing")!
const spx = betById("spx")!

describe("bets (thesis v1.2)", () => {
  it("two bets; housing keeps v1.1's odds, stocks start at 40 / 40 / 20", () => {
    expect(BETS.map((b) => b.id)).toEqual(["housing", "spx"])
    expect(housing.initial_weights).toEqual({ bear: 35, base: 45, bull: 20 })
    expect(spx.initial_weights).toEqual({ bear: 40, base: 40, bull: 20 })
    expect(spx.timing.base.rebound).toEqual(["2028-01", "2028-12"])
    expect(housing.timing.bear.rebound).toBeNull()
  })

  it("the tech basket and NASDAQ vote only for stocks (Q3); housing dials never vote for stocks", () => {
    expect(housing.dialIn("basket_index")).toBe(false)
    expect(housing.dialIn("nasdaq")).toBe(false)
    expect(spx.dialIn("basket_index")).toBe(true)
    expect(spx.dialIn("realtor_active_scc")).toBe(false)
    const votes = computeVotes(dials, {}, "2026-11-07")
    expect(betVotes(spx, votes).every((v) => spx.dialIn(v.dial_id))).toBe(true)
  })

  it("claims split by bet: C1-C3, C30, C34-C36 are stocks", () => {
    const ids = betClaims(spx, configClaims()).map((c) => c.id)
    expect(ids).toEqual(["C1", "C2", "C3", "C30", "C34", "C35", "C36"])
    expect(betClaims(housing, configClaims())).toHaveLength(29)
  })

  it("odds per bet come from that bet's newest move; old rows without bet_id are housing's", () => {
    const m = (bet_id: string | null, bear: number): WeightMove => ({ checkpoint_id: null, date: "2026-11-02", from_weights: {}, to_weights: { bear, base: 45, bull: 55 - bear }, readings_cited: null, argument: "", opposite_case: "", reverses_if: null, bootstrap_exception: false, bet_id })
    expect(betWeightsFrom([m(null, 40)])).toEqual({ housing: { bear: 40, base: 45, bull: 15 }, spx: { bear: 40, base: 40, bull: 20 } })
    expect(betWeightsFrom([m("spx", 30), m(null, 40)]).spx).toEqual({ bear: 30, base: 45, bull: 25 })
  })

  it("tripwires: the S&P -10% one is stocks-only; shared ones reach stocks when their dial is a stock dial", () => {
    const ev = (tripwire_id: string, dial_id: string) => ({ tripwire_id, dial_id, fired_on: "2027-03-02", reading: 1, detail: null, review_requested: true, reviewed_at: null })
    expect(tripwireApplies(spx, ev("spx_drawdown_10", "sp500"))).toBe(true)
    expect(tripwireApplies(housing, ev("spx_drawdown_10", "sp500"))).toBe(false)
    expect(tripwireApplies(spx, ev("ccc_oas_record", "ccc_oas"))).toBe(true)
    expect(tripwireApplies(housing, ev("ccc_oas_record", "ccc_oas"))).toBe(true)
    expect(tripwireApplies(spx, ev("scc_actives_yoy", "mls_scc_active_sfr"))).toBe(false)
  })

  it("'Now' lines read like a person wrote them", () => {
    const readings = {
      zhvi_scc_drawdown: [r("zhvi_scc_drawdown", "2026-09-30", -3.357)],
      zhvi_scc: [r("zhvi_scc", "2026-09-30", 1_717_141)],
      sp500: [r("sp500", "2026-10-06", 7818.93), r("sp500", "2026-11-04", 7688.62)],
    }
    expect(betNow(housing, { dials, readings })).toBe("3.4% below the Jan 2025 peak ($1.72M, Sep 2026)")
    expect(betNow(spx, { dials, readings })).toBe("1.7% below the Oct 6, 2026 high (7,689, Nov 4)")
    const short = claimShort({ text: "The S&P 500 makes a new all-time closing high above 7,818.93 (the Oct 6, 2026 close) before Dec 31, 2028" })
    expect(short).not.toContain("(")
    expect(short.length).toBeLessThanOrEqual(70)
    expect(claimShort({ text: "SCC ZHVI YoY >= +5% for any month of 2028 (\"next boom 2028-29\")" })).toBe("SCC ZHVI YoY >= +5% for any month of 2028")
  })
})

describe("claims settled by code (Q4)", () => {
  const sp = (pts: [string, number][]) => pts.map(([d, v]) => r("sp500", d, v))
  const sp500 = dials.find((d) => d.id === "sp500")

  it("any: true the first time it holds (even before the due date); false only once due", () => {
    const rule = claimAuto("C36")! // S&P closes ≥10% below the Oct 6 high before end of 2027
    const rows = sp([["2026-10-06", 7818.93], ["2026-11-04", 7688.62]])
    expect(autoResolve(open("C36", "2027-12-31"), rule, sp500, rows, "2026-11-07")).toBeNull()
    const hit = autoResolve(open("C36", "2027-12-31"), rule, sp500, [...rows, ...sp([["2027-03-02", 6990]])], "2027-03-03")
    expect(hit).toMatchObject({ value: true, on: "2027-03-02" })
    expect(autoResolve(open("C36", "2027-12-31"), rule, sp500, rows, "2027-12-31")).toMatchObject({ value: false })
  })

  it("all: false the moment it breaks (C1: the Oct 6 high stands through Jun 2027)", () => {
    const rule = claimAuto("C1")!
    const rows = sp([["2026-10-06", 7818.93], ["2026-12-01", 7700], ["2027-02-01", 7900]])
    expect(autoResolve(open("C1", "2027-06-30"), rule, sp500, rows, "2027-02-02")).toMatchObject({ value: false, on: "2027-02-01" })
    expect(autoResolve(open("C1", "2027-06-30"), rule, sp500, rows.slice(0, 2), "2027-02-02")).toBeNull()
    expect(autoResolve(open("C1", "2027-06-30"), rule, sp500, rows.slice(0, 2), "2027-06-30")).toMatchObject({ value: true })
  })

  it("at: one month's print, decided on the due date", () => {
    const rule = claimAuto("C33")! // SCC YoY > 0 at the Dec 2027 print
    const rows = [r("zhvi_scc_yoy", "2027-11-30", -0.4), r("zhvi_scc_yoy", "2027-12-31", 0.6)]
    expect(autoResolve(open("C33", "2028-02-15"), rule, undefined, rows, "2028-01-20")).toBeNull()
    expect(autoResolve(open("C33", "2028-02-15"), rule, undefined, rows, "2028-02-15")).toMatchObject({ value: true })
  })

  it("low_in: where the window's low landed, and the window ending above it (C34, C17)", () => {
    const rule: AutoRule = claimAuto("C34")!
    const early = sp([["2026-10-06", 7818.93], ["2027-03-10", 6500], ["2027-09-01", 6900], ["2027-12-31", 7400]])
    expect(autoResolve(open("C34", "2028-01-07"), rule, sp500, early, "2028-01-07")).toMatchObject({ value: true })
    const late = sp([["2026-10-06", 7818.93], ["2027-03-10", 7000], ["2027-10-01", 6400], ["2027-12-31", 6800]])
    expect(autoResolve(open("C34", "2028-01-07"), rule, sp500, late, "2028-01-07")).toMatchObject({ value: false })
    expect(claimAuto("C17")?.rule).toBe("low_in")
  })

  it("every auto claim names a real dial; event claims stay with the review", () => {
    const ids = new Set(dials.map((d) => d.id))
    const autos = configClaims().filter((c) => claimAuto(c.id))
    expect(autos.length).toBe(20)
    for (const c of autos) expect(ids.has(claimAuto(c.id)!.dial)).toBe(true)
    for (const id of ["C4", "C5", "C8", "C27", "C28", "C29"]) expect(claimAuto(id)).toBeNull()
  })

  it("autoClaimUpdates turns verdicts into claim resolutions", () => {
    const claims = configClaims().filter((c) => c.id === "C36") as Claim[]
    const u = autoClaimUpdates(claims, claimAuto, dials, { sp500: sp([["2026-10-06", 7818.93], ["2027-03-02", 6990]]) }, "2027-03-03")
    expect(u).toEqual([{ id: "C36", action: "resolve", value: true, reason: expect.stringContaining("auto:") }])
  })
})
