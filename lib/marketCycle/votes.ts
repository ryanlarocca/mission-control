import type { CategoryTally, Dial, DialVote, Reading, Scenario, Side, Tally, VoteKind } from "./types"

// Drift vs noise (brief §3.4). Pure. A dial may vote only if its latest
// reading passes all three tests:
//   1. Outside its band — seasonal_1sd: same calendar month over the prior
//      five years, norm ± 1σ; corridor: the authored edges in the registry
//      (market dials read as a 10-day average, CCC OAS on a two-day close).
//   2. Persistent — two consecutive readings outside the band on the same
//      side, or one beyond 2σ (seasonal only; corridors have no σ).
//   3. Directional — the registry names the scenario the move favours. A
//      persistent out-of-band move that maps to "neutral" is "unexplained":
//      an opposite-case item, never a vote.

const MAX_AGE_DAYS: Record<Dial["cadence"], number> = { daily: 10, weekly: 21, monthly: 100, quarterly: 200, event: 3650 }

export interface SeasonalBand {
  mean: number
  sd: number
  n: number | null
  source: "stored" | "history"
}

type Edge = { dir: "up" | "down"; threshold: number; scenario: Scenario; key: string; strict?: boolean }

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null)

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000)
}

function fmt(v: number): string {
  const a = Math.abs(v)
  if (a >= 1000) return Math.round(v).toLocaleString("en-US")
  if (a >= 100) return v.toFixed(0)
  const d = a >= 10 ? 2 : 3
  return v.toFixed(d).replace(/0+$/, "").replace(/\.$/, "")
}
export { fmt as formatValue }

/** Seasonal norm for the reading's calendar month: the stored by_month stats
 *  (bootstrap) when present, else computed from the dial's own history over
 *  the prior `years` calendar years. */
export function seasonalBand(dial: Dial, asOf: string, history: Reading[], years = 5): SeasonalBand | null {
  const mm = asOf.slice(5, 7)
  const c = (dial.corridor ?? {}) as Record<string, unknown>
  const computed = (c.computed ?? {}) as Record<string, unknown>
  const byMonth = (c.by_month ?? computed.by_month) as Record<string, { mean?: unknown; sd?: unknown; n?: unknown }> | undefined
  const m = byMonth?.[mm]
  if (m && num(m.mean) !== null && num(m.sd) !== null && (m.sd as number) > 0) {
    return { mean: m.mean as number, sd: m.sd as number, n: num(m.n), source: "stored" }
  }
  const y = Number(asOf.slice(0, 4))
  const perYear = new Map<number, number[]>()
  for (const r of history) {
    if (r.value === null || r.as_of.slice(5, 7) !== mm) continue
    const ry = Number(r.as_of.slice(0, 4))
    if (ry < y - years || ry > y - 1) continue
    perYear.set(ry, [...(perYear.get(ry) ?? []), r.value])
  }
  const vals = Array.from(perYear.values()).map((v) => v.reduce((a, b) => a + b, 0) / v.length)
  if (vals.length < 2) return null
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1))
  if (!(sd > 0)) return null
  return { mean, sd, n: vals.length, source: "history" }
}

/** Numeric corridor edges. Authored keys: bear_/bull_ + at_or_above /
 *  at_or_below. sp500's `bull: "new closing high"` = drawdown above 0. */
export function corridorEdges(corridor: Record<string, unknown> | null): Edge[] {
  if (!corridor || corridor.display_only === true) return []
  const out: Edge[] = []
  for (const [key, v] of Object.entries(corridor)) {
    const m = /^(bear|bull|base)_at_or_(above|below)$/.exec(key)
    const t = num(v)
    if (m && t !== null) out.push({ dir: m[2] === "above" ? "up" : "down", threshold: t, scenario: m[1] as Scenario, key })
  }
  if (corridor.bull === "new closing high") out.push({ dir: "up", threshold: 0, scenario: "bull", key: "bull", strict: true })
  return out
}

function beyond(v: number, e: Edge): boolean {
  if (e.dir === "up") return e.strict ? v > e.threshold : v >= e.threshold
  return e.strict ? v < e.threshold : v <= e.threshold
}

function shiftMonths(iso: string, months: number): string {
  const d = new Date(iso + "T00:00:00Z")
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

/** Readings in the units the corridor is written in. A corridor `transform`
 *  that differs from the dial's own transform is applied here (YoY, drawdown
 *  from a 52-week high, drawdown from a dated high); `read_as: 10d_avg` turns
 *  the series into a trailing 10-print average (≥2 prints — never one). */
export function corridorSeries(dial: Dial, readings: Reading[]): { as_of: string; value: number; note?: string }[] {
  const c = (dial.corridor ?? {}) as Record<string, unknown>
  const rows = readings.filter((r): r is Reading & { value: number } => r.value !== null).sort((a, b) => a.as_of.localeCompare(b.as_of))
  let series: { as_of: string; value: number; note?: string }[] = rows.map((r) => ({ as_of: r.as_of, value: r.value }))
  const t = typeof c.transform === "string" ? c.transform : null
  if (t && t !== dial.transform) {
    if (t === "yoy_pct") {
      const byMonth = new Map(rows.map((r) => [r.as_of.slice(0, 7), r.value]))
      series = rows.flatMap((r) => {
        const prev = byMonth.get(shiftMonths(r.as_of.slice(0, 7) + "-01", -12).slice(0, 7))
        return prev ? [{ as_of: r.as_of, value: (r.value / prev - 1) * 100 }] : []
      })
    } else if (t === "drawdown_from_52w_high") {
      series = rows.map((r) => {
        const from = shiftMonths(r.as_of, -12)
        const hi = Math.max(...rows.filter((x) => x.as_of > from && x.as_of <= r.as_of).map((x) => x.value))
        return { as_of: r.as_of, value: (r.value / hi - 1) * 100 }
      })
    } else {
      const m = /^drawdown_from_(\d{4}-\d{2}-\d{2})_high$/.exec(t)
      if (m) {
        const ref = rows.find((r) => r.as_of === m[1])?.value
        series = ref ? rows.filter((r) => r.as_of >= m[1]).map((r) => ({ as_of: r.as_of, value: (r.value / ref - 1) * 100 })) : []
      }
    }
  }
  if (c.read_as === "10d_avg") {
    series = series.flatMap((r, i) => {
      const win = series.slice(Math.max(0, i - 9), i + 1)
      if (win.length < 2) return []
      return [{ as_of: r.as_of, value: win.reduce((a, b) => a + b.value, 0) / win.length, note: `${win.length}-print avg` }]
    })
  }
  return series
}

function sideToVote(side: Side | undefined): VoteKind {
  return side === "bear" || side === "base" || side === "bull" ? side : "unexplained"
}

export function voteForDial(dial: Dial, readings: Reading[], today: string): DialVote {
  const base: DialVote = {
    dial_id: dial.id,
    name: dial.name,
    category: dial.category,
    vote: "none",
    reading: null,
    band: "—",
    z: null,
    outside: null,
    leaning: null,
    persistent: false,
    reason: "",
  }
  const rows = readings.filter((r) => r.value !== null).sort((a, b) => a.as_of.localeCompare(b.as_of))
  const last = rows[rows.length - 1]
  if (last) base.reading = { as_of: last.as_of, value: last.value as number }
  if (!dial.votes) return { ...base, reason: "context only — never a vote" }
  if (dial.band_rule === "event") return { ...base, reason: "event dial — acts through claims and tripwires" }
  if (!last) return { ...base, reason: "no reading" }
  if (daysBetween(last.as_of, today) > MAX_AGE_DAYS[dial.cadence]) return { ...base, reason: `stale (latest ${last.as_of})` }

  if (dial.band_rule === "seasonal_1sd") {
    const band = seasonalBand(dial, last.as_of, rows)
    if (!band) return { ...base, reason: "no seasonal band for this month" }
    const z = ((last.value as number) - band.mean) / band.sd
    const desc = `${fmt(band.mean)} ± ${fmt(band.sd)} (${last.as_of.slice(0, 7)} seasonal)`
    const out = { ...base, band: desc, z: Math.round(z * 100) / 100 }
    if (Math.abs(z) <= 1) return { ...out, reason: "inside its band" }
    const dir: "up" | "down" = z > 0 ? "up" : "down"
    let persistent = Math.abs(z) >= 2
    let why = persistent ? "beyond 2σ" : ""
    if (!persistent) {
      const prev = rows[rows.length - 2]
      const pb = prev ? seasonalBand(dial, prev.as_of, rows) : null
      if (prev && pb) {
        const pz = ((prev.value as number) - pb.mean) / pb.sd
        persistent = dir === "up" ? pz > 1 : pz < -1
        if (persistent) why = `2nd reading outside (${prev.as_of.slice(0, 7)} z=${pz.toFixed(2)})`
      }
    }
    const vote = sideToVote(dial.direction_map[dir])
    if (!persistent) return { ...out, outside: dir, leaning: vote, reason: "outside 1σ once — needs a second reading or 2σ" }
    return {
      ...out,
      outside: dir,
      leaning: vote,
      persistent: true,
      vote,
      reason: vote === "unexplained" ? `${why}; no scenario predicts a move ${dir}` : why,
    }
  }

  // corridor
  const edges = corridorEdges(dial.corridor)
  if (edges.length === 0) return { ...base, reason: "corridor not set" }
  const series = corridorSeries(dial, rows)
  const cur = series[series.length - 1]
  const desc = edges
    .sort((a, b) => a.threshold - b.threshold)
    .map((e) => `${e.scenario} ${e.dir === "up" ? (e.strict ? ">" : "≥") : e.strict ? "<" : "≤"} ${fmt(e.threshold)}`)
    .join(", ")
  if (!cur) return { ...base, band: desc, reason: "not enough prints for the corridor read" }
  const out: DialVote = { ...base, band: desc, reading: { as_of: cur.as_of, value: Math.round(cur.value * 1000) / 1000 } }
  // Most extreme edge first so e.g. a tripwire-level print names its own edge.
  const hit = edges
    .filter((e) => beyond(cur.value, e))
    .sort((a, b) => (a.dir === "up" ? b.threshold - a.threshold : a.threshold - b.threshold))[0]
  if (!hit) return { ...out, reason: `inside its corridor${cur.note ? ` (${cur.note})` : ""}` }
  const prev = series[series.length - 2]
  const persistent = !!prev && beyond(prev.value, hit)
  // The corridor key names the scenario (authored edges are always labelled).
  const vote = sideToVote(hit.scenario ?? dial.direction_map[hit.dir])
  if (!persistent) return { ...out, outside: hit.dir, leaning: vote, reason: "beyond the corridor once — needs a second reading" }
  return { ...out, outside: hit.dir, leaning: vote, persistent: true, vote, reason: `2 consecutive reads beyond ${hit.key.replace(/_/g, " ")} ${fmt(hit.threshold)}` }
}

export function computeVotes(dials: Dial[], readings: Record<string, Reading[]>, today: string): DialVote[] {
  return dials.map((d) => voteForDial(d, readings[d.id] ?? [], today))
}

export function tallyVotes(votes: DialVote[]): Tally {
  const byCategory: Record<string, CategoryTally> = {}
  const totals: Record<VoteKind, number> = { bear: 0, base: 0, bull: 0, none: 0, unexplained: 0 }
  for (const v of votes) {
    totals[v.vote]++
    if (v.vote === "none") continue
    const t = (byCategory[v.category] ??= { bear: [], base: [], bull: [], unexplained: [] })
    t[v.vote].push(v.dial_id)
  }
  return { byCategory, totals }
}

/** ≥3 dials from ≥2 categories voting `scenario` (brief §3.4). */
export function qualifyingBloc(votes: DialVote[], scenario: Scenario): { dials: number; categories: number; qualifies: boolean } {
  const vs = votes.filter((v) => v.vote === scenario)
  const cats = new Set(vs.map((v) => v.category)).size
  return { dials: vs.length, categories: cats, qualifies: vs.length >= 3 && cats >= 2 }
}

/** One-line tally for logs and the dry-run printout. */
export function tallyLine(t: Tally): string {
  const cats = Object.entries(t.byCategory)
    .map(([c, v]) => `${c}: ${(["bear", "base", "bull", "unexplained"] as const).filter((k) => v[k].length).map((k) => `${k} ${v[k].length}`).join(", ")}`)
    .join(" | ")
  return `bear ${t.totals.bear} · base ${t.totals.base} · bull ${t.totals.bull} · unexplained ${t.totals.unexplained}${cats ? ` — ${cats}` : ""}`
}
