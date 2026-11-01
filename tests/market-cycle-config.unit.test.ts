import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

// Market-cycle thesis config (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md,
// Part 2). Pure: reads the committed JSON, no network.

type Dial = {
  id: string
  direction_map: { up?: string; down?: string }
  band_rule: string
  cadence: string
  has_history: boolean
}
type Claim = {
  id: string
  prob_initial: number
  prob_current: number
  resolves_on: string
  scenario_tag: string
  data_source: string
  also_reads: string[]
  status: string
}
type Thesis = {
  version: string
  date: string
  scenarios: { id: string; weight: number; drawdown_bounds_pct: { min: number | null; max: number | null } }[]
  weight_moves: { n: number; from: Record<string, number | null>; to: Record<string, number>; bootstrap_exception: boolean }[]
  claims: Claim[]
  dials: Dial[]
  calendar: { date: string; dial_id: string; tentative: boolean }[]
}

const thesis: Thesis = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "config", "market-cycle", "thesis.v1.1.json"), "utf-8"),
)
const dialIds = new Set(thesis.dials.map((d) => d.id))
const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s

describe("market-cycle thesis v1.1 config", () => {
  it("has 32 claims with unique ids C1..C32", () => {
    expect(thesis.claims).toHaveLength(32)
    const ids = thesis.claims.map((c) => c.id)
    expect(new Set(ids).size).toBe(32)
    expect(ids).toEqual(Array.from({ length: 32 }, (_, i) => `C${i + 1}`))
  })

  it("every claim probability is within 0..100 and starts at its initial value", () => {
    for (const c of thesis.claims) {
      expect(c.prob_initial, c.id).toBeGreaterThanOrEqual(0)
      expect(c.prob_initial, c.id).toBeLessThanOrEqual(100)
      expect(c.prob_current, c.id).toBe(c.prob_initial)
    }
  })

  it("every resolves_on is a valid ISO date on or after 2026-11-01", () => {
    for (const c of thesis.claims) {
      expect(isIsoDate(c.resolves_on), `${c.id} ${c.resolves_on}`).toBe(true)
      expect(c.resolves_on >= "2026-11-01", `${c.id} ${c.resolves_on}`).toBe(true)
    }
  })

  it("scenario weights sum to 100 and the drawdown bounds partition the outcome", () => {
    expect(thesis.scenarios.map((s) => s.id)).toEqual(["bear", "base", "bull"])
    expect(thesis.scenarios.reduce((a, s) => a + s.weight, 0)).toBe(100)
    const [bear, base, bull] = thesis.scenarios
    expect(bear.drawdown_bounds_pct).toEqual({ min: null, max: -15 })
    expect(base.drawdown_bounds_pct).toEqual({ min: -15, max: -8 })
    expect(bull.drawdown_bounds_pct).toEqual({ min: -8, max: null })
    const last = thesis.weight_moves[thesis.weight_moves.length - 1]
    expect(last.to).toEqual({ bear: bear.weight, base: base.weight, bull: bull.weight })
    expect(thesis.weight_moves[0].bootstrap_exception).toBe(true)
  })

  it("every dial has an up/down direction_map and an allowed band_rule", () => {
    const sides = new Set(["bear", "base", "bull", "neutral"])
    const rules = new Set(["seasonal_1sd", "corridor", "event"])
    expect(dialIds.size).toBe(thesis.dials.length)
    for (const d of thesis.dials) {
      expect(sides.has(d.direction_map.up ?? ""), `${d.id} up`).toBe(true)
      expect(sides.has(d.direction_map.down ?? ""), `${d.id} down`).toBe(true)
      expect(rules.has(d.band_rule), `${d.id} ${d.band_rule}`).toBe(true)
    }
  })

  it("every claim's data_source (and also_reads) names a dial, 'event' or 'manual'", () => {
    for (const c of thesis.claims) {
      for (const src of [c.data_source, ...c.also_reads]) {
        expect(dialIds.has(src) || src === "event" || src === "manual", `${c.id} -> ${src}`).toBe(true)
      }
    }
  })

  it("every calendar entry feeds a registered dial and has a date or TBD", () => {
    for (const e of thesis.calendar) {
      expect(dialIds.has(e.dial_id), e.dial_id).toBe(true)
      expect(e.date === "TBD" || isIsoDate(e.date), e.date).toBe(true)
    }
  })
})
