import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { configCalendar, configClaims, configDials } from "@/lib/marketCycle/config"
import { computeVotes, qualifyingBloc, seasonalBand, tallyVotes, voteForDial } from "@/lib/marketCycle/votes"
import { checkProposal, clampMove } from "@/lib/marketCycle/rules"
import { applyClaimUpdates, brier, dueClaims, liveProbability, resolveClaim } from "@/lib/marketCycle/claims"
import { checkpointDue, lastMondayOf, mondayAfter, mondayOnOrAfter, nextCheckpoint, plannedDate, scheduledCheckpointInMonth } from "@/lib/marketCycle/schedule"
import { MAX_CARD_LINES, renderCard, renderTripwireCard } from "@/lib/marketCycle/card"
import { parseProposal } from "@/lib/marketCycle/prompt"
import { runReview } from "@/lib/marketCycle/review"
import { stateFromFixture, type CheckpointWriter, type Fixture } from "@/lib/marketCycle/data"
import type { CalendarEntry, Checkpoint, Dial, DialVote, Proposal, Reading, TripwireEvent, Weights } from "@/lib/marketCycle/types"

// Market-cycle review (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md §3.4–3.5).
// Pure: config + fixture JSON, no network, no Supabase, no model.

const dials = configDials()
const dial = (id: string) => {
  const d = dials.find((x) => x.id === id)
  if (!d) throw new Error(id)
  return d
}
const withCorridor = (d: Dial, corridor: Record<string, unknown>): Dial => ({ ...d, corridor: { ...(d.corridor ?? {}), ...corridor } })
const r = (dial_id: string, as_of: string, value: number): Reading => ({ dial_id, as_of, value })
const fixture: Fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/market-cycle/readings-2026-11.json"), "utf-8"))
const W0: Weights = { bear: 35, base: 45, bull: 20 }

function vote(dial_id: string, category: string, v: DialVote["vote"], value = 1): DialVote {
  return { dial_id, name: dial_id, category, vote: v, reading: { as_of: "2026-12-01", value }, band: "", z: null, outside: null, leaning: null, persistent: v !== "none", reason: "" }
}
function proposal(p: Partial<Proposal>): Proposal {
  return { proposed_weights: W0, argument: "a", opposite_case: "rents still rising", opposite_reading: null, reverses_if: null, dials_moved: [], claim_updates: [], next_dates: [], ...p }
}

describe("votes (§3.4 tests 1-3)", () => {
  const actives = withCorridor(dial("realtor_active_scc"), { by_month: { "08": { mean: 1300, sd: 230 }, "09": { mean: 1360, sd: 239 } } })
  const pending = withCorridor(dial("realtor_pending_ratio_scc"), { by_month: { "08": { mean: 0.9, sd: 0.3 }, "09": { mean: 0.853, sd: 0.335 } } })

  it("band: a reading beyond 2σ of its seasonal band votes on its own (actives 1987 vs 1360±239 → bear)", () => {
    const v = voteForDial(actives, [r(actives.id, "2026-09-01", 1987)], "2026-11-01")
    expect(v.z).toBeCloseTo(2.62, 2)
    expect(v.vote).toBe("bear")
    expect(v.persistent).toBe(true)
  })

  it("inside the band: no vote", () => {
    const v = voteForDial(actives, [r(actives.id, "2026-09-01", 1500)], "2026-11-01")
    expect(v.vote).toBe("none")
    expect(v.outside).toBeNull()
  })

  it("persistence: one reading outside 1σ (pending ratio 0.427, z −1.27) is not a vote; two consecutive are", () => {
    const once = voteForDial(pending, [r(pending.id, "2026-09-01", 0.427)], "2026-11-01")
    expect(once.vote).toBe("none")
    expect(once.outside).toBe("down")
    expect(once.leaning).toBe("bear")
    const twice = voteForDial(pending, [r(pending.id, "2026-08-01", 0.5), r(pending.id, "2026-09-01", 0.427)], "2026-11-01")
    expect(twice.vote).toBe("bear")
    // previous reading outside on the OTHER side does not count
    const flip = voteForDial(pending, [r(pending.id, "2026-08-01", 1.3), r(pending.id, "2026-09-01", 0.427)], "2026-11-01")
    expect(flip.vote).toBe("none")
  })

  it("corridor: one print beyond the edge is not a vote, two consecutive are (sj rent ≥4 → bull)", () => {
    const d = dial("sj_rent_yoy")
    expect(voteForDial(d, [r(d.id, "2026-09-01", 7.9)], "2026-11-01").vote).toBe("none")
    expect(voteForDial(d, [r(d.id, "2026-08-01", 8.4), r(d.id, "2026-09-01", 7.9)], "2026-11-01").vote).toBe("bull")
  })

  it("market dials read as a 10-day average, never one print (Brent ≥120 → bear)", () => {
    const d = dial("brent")
    expect(voteForDial(d, [r(d.id, "2026-10-26", 123)], "2026-11-01").vote).toBe("none")
    const days = Array.from({ length: 12 }, (_, i) => r(d.id, `2026-10-${String(15 + i).padStart(2, "0")}`, 121 + (i % 3)))
    const v = voteForDial(d, days, "2026-11-01")
    expect(v.vote).toBe("bear")
    expect(v.reading?.value).toBeGreaterThanOrEqual(120)
  })

  it("corridor transform: basket drawdown from its 52-week high (−20.5%) sits inside −30..−10", () => {
    const d = dial("basket_index")
    const v = voteForDial(d, [r(d.id, "2026-06-30", 100), r(d.id, "2026-10-30", 79.5)], "2026-11-01")
    expect(v.reading?.value).toBeCloseTo(-20.5, 5)
    expect(v.vote).toBe("none")
  })

  it("unexplained: a persistent out-of-band move no scenario predicts is logged, not counted as a vote", () => {
    const odd: Dial = { ...actives, id: "odd", category: "local_housing", direction_map: { up: "neutral", down: "bull" } }
    const v = voteForDial(odd, [r("odd", "2026-09-01", 2500)], "2026-11-01")
    expect(v.vote).toBe("unexplained")
    const t = tallyVotes([v, vote("x", "credit", "bear")])
    expect(t.totals.unexplained).toBe(1)
    expect(t.byCategory.local_housing.unexplained).toEqual(["odd"])
    expect(t.totals.bear).toBe(1)
  })

  it("the scored object votes on its own partition lines, even with a bootstrap corridor stored in the DB", () => {
    // Bootstrap stores its stats nested (scenario_bounds_pct); before the fix the
    // dial read "corridor not set" at every review.
    const stored = { computed: { scenario_bounds_pct: { bull_above: -8, bear_at_or_below: -15 } }, rule: "corridor" }
    const dd = configDials(undefined, { zhvi_scc_drawdown: stored }).find((d) => d.id === "zhvi_scc_drawdown")!
    const v = (vals: [string, number][]) => voteForDial(dd, vals.map(([a, b]) => r(dd.id, a, b)), "2026-11-01")
    expect(v([["2026-08-31", -3.8], ["2026-09-30", -3.4]]).reason).toMatch(/inside its corridor/)
    expect(v([["2026-08-31", -8.5], ["2026-09-30", -9.1]]).vote).toBe("base")
    expect(v([["2026-08-31", -15.2], ["2026-09-30", -16]]).vote).toBe("bear")
    expect(v([["2026-08-31", -7], ["2026-09-30", -9]]).vote).toBe("none") // once — needs a second print
  })

  it("context-only, event and stale dials never vote", () => {
    expect(voteForDial(dial("zhvi_zip_95118"), [r("zhvi_zip_95118", "2026-09-01", -9)], "2026-11-01").reason).toMatch(/context only/)
    expect(voteForDial(dial("fomc_decision"), [r("fomc_decision", "2026-10-28", 1)], "2026-11-01").vote).toBe("none")
    expect(voteForDial(actives, [r(actives.id, "2026-01-01", 3000)], "2026-11-01").reason).toMatch(/stale/)
  })

  it("seasonal band is computed from history when none is stored (same month, prior 5 years)", () => {
    const bare: Dial = { ...dial("realtor_active_scc"), corridor: null }
    const hist = [2021, 2022, 2023, 2024, 2025].map((y, i) => r(bare.id, `${y}-09-01`, 1000 + i * 100))
    const b = seasonalBand(bare, "2026-09-01", hist)
    expect(b?.source).toBe("history")
    expect(b?.mean).toBe(1200)
    expect(b?.sd).toBeCloseTo(158.11, 1)
  })

  it("tally by category + the ≥3-dials-from-≥2-categories bloc", () => {
    const vs = [vote("a", "credit", "bear"), vote("b", "credit", "bear"), vote("c", "rates", "bear"), vote("d", "rates", "bull")]
    const t = tallyVotes(vs)
    expect(t.byCategory.credit.bear).toEqual(["a", "b"])
    expect(qualifyingBloc(vs, "bear")).toEqual({ dials: 3, categories: 2, qualifies: true })
    expect(qualifyingBloc(vs.slice(0, 2).concat(vote("e", "credit", "bear")), "bear").qualifies).toBe(false) // 3 dials, 1 category
  })

  it("fixture (brief Phase 0 numbers): only SCC actives votes — bear, local housing", () => {
    const st = stateFromFixture(fixture)
    const vs = computeVotes(st.dials, st.readings, st.today)
    const voting = vs.filter((v) => v.vote !== "none")
    expect(voting.map((v) => [v.dial_id, v.vote])).toEqual([["realtor_active_scc", "bear"]])
    expect(vs.find((v) => v.dial_id === "realtor_price_reduced_scc")?.leaning).toBe("bear")
  })
})

describe("rules (vote_rules)", () => {
  const bloc = [vote("realtor_active_scc", "local_housing", "bear"), vote("realtor_price_reduced_scc", "local_housing", "bear"), vote("ccc_oas", "credit", "bear"), vote("sj_rent_yoy", "local_housing", "bull")]
  const claims = configClaims()
  const cites = [
    { dial_id: "realtor_active_scc", reading: "1987", direction: "up" as const, scenario: "bear" as const },
    { dial_id: "ccc_oas", reading: "15.4", direction: "up" as const, scenario: "bear" as const },
  ]
  const legal = proposal({ proposed_weights: { bear: 40, base: 45, bull: 15 }, dials_moved: cites, opposite_reading: { dial_id: "sj_rent_yoy", reading: "7.9" } })

  it("allows a move backed by ≥3 dials from ≥2 categories", () => {
    const v = checkProposal({ before: W0, proposal: legal, votes: bloc, claims, today: "2027-01-18", tripwirePending: false })
    expect(v.violations).toEqual([])
    expect(v.ok).toBe(true)
    expect(v.weights).toEqual({ bear: 40, base: 45, bull: 15 })
    expect(v.direction).toBe("bear")
  })

  it("blocks a move without the bloc, a resolution or a tripwire", () => {
    const v = checkProposal({ before: W0, proposal: legal, votes: bloc.slice(0, 2).concat(bloc[3]), claims, today: "2027-01-18", tripwirePending: false })
    expect(v.ok).toBe(false)
    expect(v.weights).toEqual(W0)
    expect(v.violations.join(" ")).toMatch(/move gate/)
  })

  it("a due claim resolution or a pending tripwire opens the gate and lifts the cap to 25", () => {
    const few = [vote("realtor_active_scc", "local_housing", "bear"), vote("ccc_oas", "credit", "bear"), vote("sj_rent_yoy", "local_housing", "bull")]
    const p = proposal({ ...legal, proposed_weights: { bear: 55, base: 35, bull: 10 }, claim_updates: [{ id: "C5", action: "resolve", value: true, reason: "Fed hiked Dec 16" }] })
    const v = checkProposal({ before: W0, proposal: p, votes: few, claims, today: "2026-12-16", tripwirePending: false })
    expect(v.ok).toBe(true)
    expect(v.claimResolved).toBe(true)
    expect(v.cap).toBe(25)
    expect(v.weights.bear).toBe(55)
    const t = checkProposal({ before: W0, proposal: legal, votes: few, claims, today: "2027-03-02", tripwirePending: true })
    expect(t.ok).toBe(true)
    expect(t.cap).toBe(25)
  })

  it("clamps an over-cap move to 15 points, keeping whole numbers summing to 100", () => {
    const p = proposal({ ...legal, proposed_weights: { bear: 57, base: 30, bull: 13 } })
    const v = checkProposal({ before: W0, proposal: p, votes: bloc, claims, today: "2027-01-18", tripwirePending: false })
    expect(v.ok).toBe(true)
    expect(v.adjustments.length).toBe(1)
    expect(v.weights.bear - W0.bear).toBe(15)
    expect(v.weights.bear + v.weights.base + v.weights.bull).toBe(100)
    expect(Math.max(...(["bear", "base", "bull"] as const).map((s) => Math.abs(v.weights[s] - W0[s])))).toBeLessThanOrEqual(15)
    expect(clampMove(W0, { bear: 55, base: 30, bull: 15 }, 15)).toEqual({ bear: 50, base: 34, bull: 16 })
  })

  it("rejects a move citing fewer than two readings, or a reading not in hand", () => {
    const one = checkProposal({ before: W0, proposal: { ...legal, dials_moved: cites.slice(0, 1) }, votes: bloc, claims, today: "2027-01-18", tripwirePending: false })
    expect(one.violations.join(" ")).toMatch(/≥2 readings/)
    const bogus = checkProposal({ before: W0, proposal: { ...legal, dials_moved: [...cites, { dial_id: "nope", reading: "1", direction: "up", scenario: "bear" }] }, votes: bloc, claims, today: "2027-01-18", tripwirePending: false })
    expect(bogus.violations.join(" ")).toMatch(/no reading in hand: nope/)
  })

  it("requires a non-empty opposite case naming the strongest disagreeing reading", () => {
    const empty = checkProposal({ before: W0, proposal: { ...legal, opposite_case: " " }, votes: bloc, claims, today: "2027-01-18", tripwirePending: false })
    expect(empty.violations).toContain("opposite case is empty")
    const same = checkProposal({ before: W0, proposal: { ...legal, opposite_reading: { dial_id: "ccc_oas", reading: "15.4" } }, votes: bloc, claims, today: "2027-01-18", tripwirePending: false })
    expect(same.violations.join(" ")).toMatch(/same way as the move/)
    const weak = checkProposal({ before: W0, proposal: { ...legal, opposite_reading: { dial_id: "unrelated", reading: "1" } }, votes: [...bloc, vote("unrelated", "macro", "none")], claims, today: "2027-01-18", tripwirePending: false })
    expect(weak.violations.join(" ")).toMatch(/must be one of the bull votes/)
  })

  it("weights must sum to 100; a no-move proposal is always legal; early resolutions need a tripwire", () => {
    const bad = checkProposal({ before: W0, proposal: { ...legal, proposed_weights: { bear: 40, base: 45, bull: 20 } }, votes: bloc, claims, today: "2027-01-18", tripwirePending: false })
    expect(bad.violations.join(" ")).toMatch(/sum to 105/)
    expect(checkProposal({ before: W0, proposal: proposal({}), votes: [], claims, today: "2027-01-18", tripwirePending: false }).ok).toBe(true)
    const early = checkProposal({ before: W0, proposal: proposal({ claim_updates: [{ id: "C27", action: "resolve", value: true, reason: "x" }] }), votes: [], claims, today: "2026-12-01", tripwirePending: false })
    expect(early.violations.join(" ")).toMatch(/C27: not due/)
  })
})

describe("claims", () => {
  const claims = configClaims()
  it("detects due claims (resolves_on ≤ today, still open)", () => {
    expect(dueClaims(claims, "2026-12-15").map((c) => c.id)).toEqual([])
    expect(dueClaims(claims, "2026-12-16").map((c) => c.id)).toEqual(["C5"])
    expect(dueClaims(claims, "2026-12-31").map((c) => c.id).sort()).toEqual(["C27", "C5"])
    expect(dueClaims(claims.map((c) => (c.id === "C5" ? { ...c, status: "resolved" as const } : c)), "2026-12-31").map((c) => c.id)).toEqual(["C27"])
  })

  it("scores both Briers: live on the last checkpoint before resolution, initial on prob_initial", () => {
    const c5 = claims.find((c) => c.id === "C5")!
    const cps = [
      { id: "a", date: "2026-12-14", kind: "shakedown", claims_resolved: [{ id: "C5", action: "reprob", value: 80, reason: "dots" }] },
      { id: "b", date: "2026-12-16", kind: "tripwire", claims_resolved: [{ id: "C5", action: "reprob", value: 99, reason: "same day — ignored" }] },
    ] as unknown as Checkpoint[]
    expect(liveProbability(c5, cps, "2026-12-16")).toBe(80)
    const res = resolveClaim(c5, true, "2026-12-16", cps)
    expect(res.status).toBe("resolved")
    expect(res.brier_live).toBeCloseTo(0.04, 6) // (0.80 − 1)²
    expect(res.brier_initial).toBeCloseTo(0.0625, 6) // (0.75 − 1)²
    expect(brier(60, false)).toBeCloseTo(0.36, 6)
    expect(resolveClaim(c5, "void", "2026-12-16", cps).brier_live).toBeNull()
  })

  it("applies re-probabilisations and resolutions in order", () => {
    const out = applyClaimUpdates(claims, [{ id: "C9", action: "reprob", value: 35, reason: "r" }, { id: "C5", action: "resolve", value: false, reason: "held" }], "2026-12-16", [])
    expect(out.find((c) => c.id === "C9")?.prob_current).toBe(35)
    expect(out.find((c) => c.id === "C5")?.brier_initial).toBeCloseTo(0.5625, 6)
  })
})

describe("schedule (data-ready cadence, Ryan 2026-11-07)", () => {
  const fomc = (dates: string[]): CalendarEntry[] => dates.map((d) => ({ date: d, label: "FOMC decision", dial_id: "fomc_decision", tentative: false }))
  // last month's CPI + Zillow prints stored (as_of month = ym − 1)
  const prints = (ym: string): Record<string, Reading[]> => ({
    cpi_yoy: [{ dial_id: "cpi_yoy", as_of: `${ym}-01`, value: 3.1, source_url: "x", raw: null }],
    zhvi_scc: [{ dial_id: "zhvi_scc", as_of: `${ym}-30`, value: 1_717_000, source_url: "x", raw: null }],
  })
  const noZillow = (ym: string): Record<string, Reading[]> => ({ cpi_yoy: prints(ym).cpi_yoy, zhvi_scc: [{ dial_id: "zhvi_scc", as_of: "2026-09-30", value: 1, source_url: "x", raw: null }] })
  const none: TripwireEvent[] = []
  const inp = (readings: Record<string, Reading[]>, calendar: CalendarEntry[] = [], checkpoints: { date: string; kind: Checkpoint["kind"] }[] = []) => ({ calendar, readings, checkpoints })

  it("helpers: first Monday on/after the 15th, last Monday, Monday after", () => {
    expect(plannedDate("2026-12")).toBe("2026-12-21")
    expect(plannedDate("2027-03")).toBe("2027-03-15")
    expect(lastMondayOf("2027-01")).toBe("2027-01-25")
    expect(lastMondayOf("2027-02")).toBe("2027-02-22")
    expect(mondayAfter("2027-03-10")).toBe("2027-03-15")
    expect(mondayOnOrAfter("2027-06-15")).toBe("2027-06-21")
  })

  it("the shakedown is Mon Dec 21, 2026 (the Dec 16 Fed decision is before it); nothing before December", () => {
    const cal = fomc(["2026-12-16"])
    expect(scheduledCheckpointInMonth("2026-12", cal)).toEqual({ date: "2026-12-21", kind: "shakedown" })
    expect(checkpointDue("2026-12-21", inp(prints("2026-11"), cal), none)).toMatchObject({ due: true, kind: "shakedown" })
    expect(checkpointDue("2026-12-14", inp(prints("2026-11"), cal), none).due).toBe(false)
    expect(scheduledCheckpointInMonth("2026-11", cal)).toBeNull()
    expect(nextCheckpoint("2026-11-07", { calendar: cal, checkpoints: [] })).toEqual({ date: "2026-12-21", kind: "shakedown" })
  })

  it("waits for last month's Zillow print, then runs on the next Monday", () => {
    expect(checkpointDue("2027-03-15", inp(noZillow("2027-02")), none)).toMatchObject({ due: false })
    expect(checkpointDue("2027-03-15", inp(noZillow("2027-02")), none).reason).toMatch(/zhvi_scc/)
    expect(checkpointDue("2027-03-17", inp(prints("2027-02")), none)).toMatchObject({ due: false }) // data in on a Wednesday → next Monday
    expect(checkpointDue("2027-03-22", inp(prints("2027-02")), none)).toMatchObject({ due: true, kind: "monthly" })
  })

  it("slides a week past an FOMC decision that day or within 3 days", () => {
    const cal = fomc(["2027-03-17"])
    expect(scheduledCheckpointInMonth("2027-03", cal)).toEqual({ date: "2027-03-22", kind: "monthly" })
    expect(checkpointDue("2027-03-15", inp(prints("2027-02"), cal), none).due).toBe(false)
    expect(checkpointDue("2027-03-22", inp(prints("2027-02"), cal), none).due).toBe(true)
  })

  it("last-Monday fallback runs whatever arrived, catches up a missed day, and still dodges the Fed", () => {
    expect(checkpointDue("2027-03-29", inp(noZillow("2027-02")), none)).toMatchObject({ due: true, kind: "monthly" })
    expect(checkpointDue("2027-03-30", inp(noZillow("2027-02")), none).due).toBe(true) // Monday's run was missed
    const jan = fomc(["2027-01-27"])
    expect(scheduledCheckpointInMonth("2027-01", jan)).toEqual({ date: "2027-01-18", kind: "monthly" })
    expect(checkpointDue("2027-01-25", inp(noZillow("2027-01"), jan), none).due).toBe(false) // Fed on the 27th
    expect(checkpointDue("2027-01-27", inp(noZillow("2027-01"), jan), none).due).toBe(false) // decision day itself
    expect(checkpointDue("2027-01-28", inp(noZillow("2027-01"), jan), none).due).toBe(true)
  })

  it("once per month: a stored scheduled checkpoint ends it; a tripwire review doesn't", () => {
    const done = inp(prints("2027-02"), [], [{ date: "2027-03-15", kind: "monthly" }])
    expect(checkpointDue("2027-03-22", done, none).due).toBe(false)
    expect(checkpointDue("2027-03-29", done, none).due).toBe(false)
    const tw = inp(prints("2027-02"), [], [{ date: "2027-03-03", kind: "tripwire" }])
    expect(checkpointDue("2027-03-15", tw, none)).toMatchObject({ due: true, kind: "monthly" })
    expect(nextCheckpoint("2027-03-15", { calendar: [], checkpoints: [{ date: "2027-03-15", kind: "monthly" }] })).toEqual({ date: "2027-04-19", kind: "monthly" })
  })

  it("quarterly = the Feb / May / Aug / Nov review", () => {
    expect(scheduledCheckpointInMonth("2027-02", [])?.kind).toBe("quarterly")
    expect(scheduledCheckpointInMonth("2027-05", [])?.kind).toBe("quarterly")
    expect(scheduledCheckpointInMonth("2027-08", [])?.kind).toBe("quarterly")
    expect(scheduledCheckpointInMonth("2027-11", [])?.kind).toBe("quarterly")
    expect(scheduledCheckpointInMonth("2027-03", [])?.kind).toBe("monthly")
  })

  it("a tripwire with review_requested and no reviewed_at makes a review due out of cycle", () => {
    const ev: TripwireEvent = { tripwire_id: "ccc_oas_record", dial_id: "ccc_oas", fired_on: "2027-03-02", reading: 20.4, detail: null, review_requested: true, reviewed_at: null }
    expect(checkpointDue("2027-03-03", inp({}), [ev])).toMatchObject({ due: true, kind: "tripwire", tripwirePending: true })
    expect(checkpointDue("2027-03-03", inp({}), [{ ...ev, reviewed_at: "2027-03-03T15:00:00Z" }]).due).toBe(false)
    expect(checkpointDue("2027-03-03", inp({}), [{ ...ev, review_requested: false }]).due).toBe(false)
    // a scheduled review the same day keeps its kind and carries the tripwire
    expect(checkpointDue("2027-03-15", inp(prints("2027-02")), [ev])).toMatchObject({ due: true, kind: "monthly", tripwirePending: true })
  })

  it("the config calendar knows the 2027 Fed meetings and CPI prints", () => {
    const cal = configCalendar()
    expect(cal.filter((e) => e.dial_id === "fomc_decision" && e.date?.startsWith("2027")).length).toBe(8)
    expect(cal.filter((e) => e.dial_id === "cpi_yoy" && e.date?.startsWith("2027")).length).toBe(12)
  })
})

describe("card", () => {
  const base = {
    date: "2027-01-18",
    kind: "monthly" as const,
    before: W0,
    after: { bear: 40, base: 45, bull: 15 },
    moved: true,
    why: "three categories agree & a tripwire fired; <b>the IPO window</b> is wobbling",
    opposite: "rents +7%, curve still steep, Dec sales +2% YoY",
    resolved: ["C5 ✅ (we said 75)"],
    reprobs: ["C9 45→35"],
    next: ["Jan 27, 2027 FOMC", "Feb 10, 2027 CPI"],
    checkpointId: "6f1c1d1e-1111-4222-8333-944455556666",
    baseUrl: "https://mission-control-three-chi.vercel.app",
  }
  const bullets = Array.from({ length: 6 }, (_, i) => ({ label: `Dial ${i} <x> & y`, category: "credit", scenario: "bear" as const }))

  it("fits in ≤12 lines with every section, the year, and the overflow line", () => {
    const c = renderCard({ ...base, bullets })
    const lines = c.text.split("\n")
    expect(lines.length).toBeLessThanOrEqual(MAX_CARD_LINES)
    expect(lines[0]).toContain("Market cycle — Jan 18, 2027 checkpoint")
    expect(lines[1]).toBe("Bear 35 → 40 · Base 45 → 45 · Bull 20 → 15")
    for (const s of ["<b>Moved</b>", "<b>Why</b>:", "<b>Opposite case</b>:", "<b>Resolved</b>:", "<b>Next</b>:"]) expect(c.text).toContain(s)
    expect(c.text).toContain("(credit → bear)")
    expect(c.text).toContain("+3 more on /cycle")
    expect(c.text).toContain("re-probbed C9 45→35")
  })

  it("HTML-escapes every dynamic string", () => {
    const c = renderCard({ ...base, bullets })
    expect(c.text).toContain("Dial 0 &lt;x&gt; &amp; y")
    expect(c.text).toContain("&lt;b&gt;the IPO window&lt;/b&gt;")
    expect(c.text).not.toContain("<x>")
  })

  it("carries Details (URL to /cycle) and Disagree (cycle:disagree:<id>, ≤64 bytes)", () => {
    const [[details, disagree]] = renderCard({ ...base, bullets }).buttons
    expect(details.url).toBe("https://mission-control-three-chi.vercel.app/cycle")
    expect(disagree.callback_data).toBe(`cycle:disagree:${base.checkpointId}`)
    expect(Buffer.byteLength(disagree.callback_data!)).toBeLessThanOrEqual(64)
  })

  it("clips a long Why / Opposite case to stay phone-sized", () => {
    const c = renderCard({ ...base, bullets, why: "x".repeat(500), opposite: "y ".repeat(300) })
    const why = c.text.split("\n").find((l) => l.startsWith("<b>Why</b>"))!
    expect(why.length).toBeLessThan(260)
    expect(why.endsWith("…")).toBe(true)
  })

  it("a no-move card says so; the tripwire card is three lines", () => {
    const c = renderCard({ ...base, after: W0, moved: false, bullets: [], resolved: [], reprobs: [] })
    expect(c.text).toContain("<b>Moved</b>: nothing")
    expect(c.text).toContain("<b>Resolved</b>: none")
    const t = renderTripwireCard({ what: "CCC OAS ≥ 20% on a two-day close", reading: "20.4% (Mar 2, 2027) <hi>", baseUrl: base.baseUrl })
    expect(t.text.split("\n")).toHaveLength(3)
    expect(t.text).toContain("Out-of-cycle review within 24h.")
    expect(t.text).toContain("&lt;hi&gt;")
  })
})

describe("prompt contract + review orchestration (dry, injected deps)", () => {
  it("parses the model JSON and coerces values", () => {
    const p = parseProposal(
      JSON.stringify({
        proposed_weights: { bear: "40", base: 45, bull: 15 },
        argument: " a ",
        opposite_case: "b",
        opposite_reading: { dial_id: "sj_rent_yoy", reading: "7.9" },
        dials_moved: [{ dial_id: "x", reading: "1", direction: "down", scenario: "bear" }, { dial_id: "y", scenario: "nope" }],
        claim_updates: [{ id: "C5", action: "resolve", value: "true", reason: "r" }, { id: "C9", action: "reprob", value: "35", reason: "r" }, { id: "C1", action: "rewrite" }],
        next_dates: ["Jan 27, 2027 FOMC"],
      }),
    )
    expect(p.proposed_weights.bear).toBe(40)
    expect(p.dials_moved).toHaveLength(1)
    expect(p.claim_updates).toEqual([{ id: "C5", action: "resolve", value: true, reason: "r" }, { id: "C9", action: "reprob", value: 35, reason: "r" }])
  })

  it("dry run on the fixture: stub proposal, no move, card ≤12 lines, no weight-move row", async () => {
    const res = await runReview({ dryRun: true, kind: "shakedown" }, { loadState: async () => stateFromFixture(fixture) })
    expect(res.proposalSource).toBe("stub")
    expect(res.verdict?.ok).toBe(true)
    expect(res.rows?.weightMove).toBeNull()
    expect(res.rows?.checkpoint.kind).toBe("shakedown")
    expect(res.card!.text.split("\n").length).toBeLessThanOrEqual(MAX_CARD_LINES)
    expect(res.proposal?.opposite_reading?.dial_id).toBe("sj_rent_yoy")
  })

  it("re-asks once on a rule break, then falls back to no move with the violations logged", async () => {
    const illegal = JSON.stringify({ proposed_weights: { bear: 50, base: 40, bull: 10 }, argument: "x", opposite_case: "y", dials_moved: [], claim_updates: [], next_dates: [] })
    const calls: string[] = []
    const writes: string[] = []
    const writer: CheckpointWriter = {
      insertCheckpoint: async () => { writes.push("checkpoint"); return "11111111-2222-4333-8444-555555555555" },
      insertWeightMove: async () => { writes.push("move") },
      updateClaims: async () => { writes.push("claims") },
      setTelegramMessageId: async () => { writes.push("tg") },
      markTripwiresReviewed: async () => { writes.push("tripwires") },
    }
    const res = await runReview(
      { dryRun: false, kind: "monthly" },
      { loadState: async () => stateFromFixture(fixture), callModel: async (_s, p) => { calls.push(p); return illegal }, writer, sendCard: async () => 4242 },
    )
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain("broke these rules")
    expect(res.proposalSource).toBe("model-fallback")
    expect(res.verdict?.violations.join(" ")).toMatch(/move gate/)
    expect(res.rows?.checkpoint.weights_after).toEqual(W0)
    expect(res.rows?.weightMove).toBeNull()
    expect(writes).toEqual(["checkpoint", "tg", "tripwires"])
    expect(res.card?.buttons[0][1].callback_data).toBe("cycle:disagree:11111111-2222-4333-8444-555555555555")
  })

  it("--check skips quietly when nothing is due", async () => {
    const res = await runReview({ dryRun: true, check: true }, { loadState: async () => stateFromFixture(fixture) })
    expect(res.skipped).toBe(true)
  })
})
