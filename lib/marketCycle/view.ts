import { longDate } from "./card"
import { seasonalBand } from "./votes"
import type { DisplayFormat } from "./display"
import type { Dial, Reading } from "./types"

// Pure view-model helpers for /cycle (brief v2 Phase 3). No React, no I/O, so
// vitest can cover them (the page itself has no test harness).

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const LETTER = "JFMAMJJASOND"

export interface MonthSlot {
  ym: string
  letter: string
  value: number | null
}

function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return d.toISOString().slice(0, 7)
}

const valued = (rows: Reading[]) => rows.filter((r): r is Reading & { value: number } => r.value !== null)

/** Every chart = the last 12 months ending at the dial's newest reading, one
 *  point per month (the month's last reading), gaps as null (Ryan: "keep
 *  everything to 12 months", with month letters under the chart). */
export function last12Months(rows: Reading[]): MonthSlot[] {
  const v = valued(rows)
  if (!v.length) return []
  const end = v[v.length - 1].as_of.slice(0, 7)
  const byMonth = new Map<string, number>()
  for (const r of v) byMonth.set(r.as_of.slice(0, 7), r.value)
  return Array.from({ length: 12 }, (_, i) => {
    const ym = addMonths(end, i - 11)
    return { ym, letter: LETTER[Number(ym.slice(5, 7)) - 1], value: byMonth.get(ym) ?? null }
  })
}

export type Tone = "good" | "bad" | "flat"
export interface Trend {
  arrow: "▲" | "▼" | "▬"
  tone: Tone
  prev: { as_of: string; value: number } | null
}

const MIN_GAP_DAYS: Record<string, number> = { daily: 1, weekly: 5, monthly: 20, quarterly: 60, event: 1 }
const days = (a: string, b: string) => (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000

/** The previous reading a real period back (a re-run the day after is not "last week"). */
export function previousReading(dial: Pick<Dial, "cadence">, rows: Reading[]): { as_of: string; value: number } | null {
  const v = valued(rows)
  const last = v[v.length - 1]
  if (!last) return null
  const gap = MIN_GAP_DAYS[dial.cadence] ?? 1
  for (let i = v.length - 2; i >= 0; i--) if (days(v[i].as_of, last.as_of) >= gap) return { as_of: v[i].as_of, value: v[i].value }
  return null
}

/** ▲▼▬ = direction since the previous reading; tone = what that means for SCC
 *  house prices (the dial's own up/down → bull/bear map): green good, red bad,
 *  gray flat or context (Ryan 2026-11-07). */
export function trend(dial: Pick<Dial, "cadence" | "direction_map">, rows: Reading[], format: DisplayFormat, context = false): Trend {
  const v = valued(rows)
  const last = v[v.length - 1]
  const prev = previousReading(dial, rows)
  if (!last || !prev) return { arrow: "▬", tone: "flat", prev }
  const d = last.value - prev.value
  const pctLike = format === "pct" || format === "pct_signed" || format === "pts" || format === "ratio"
  const flat = pctLike ? Math.abs(d) < (format === "ratio" ? 0.005 : 0.05) : Math.abs(d) <= Math.abs(prev.value) * 0.01
  if (flat) return { arrow: "▬", tone: "flat", prev }
  const up = d > 0
  const side = dial.direction_map[up ? "up" : "down"]
  const tone: Tone = context ? "flat" : side === "bull" ? "good" : side === "bear" ? "bad" : "flat"
  return { arrow: up ? "▲" : "▼", tone, prev }
}

export function formatValue(v: number, f: DisplayFormat): string {
  const n = (x: number, d = 0) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
  switch (f) {
    case "pct":
      return `${n(v, Math.abs(v) < 10 ? 2 : 1).replace(/0$/, "")}%`
    case "pct_signed":
      return `${v > 0 ? "+" : v < 0 ? "−" : ""}${n(Math.abs(v), 1)}%`
    case "usd":
      return `$${n(v, Math.abs(v) < 1000 ? 0 : 0)}`
    case "usd_m":
      return `$${n(v / 1e6, 2)}M`
    case "int":
      return n(v)
    case "ratio":
      return n(v, 2)
    case "pts":
      return `${v > 0 ? "+" : ""}${n(v, 2)}`
    default:
      return Math.abs(v) >= 100 ? n(v) : n(v, Math.abs(v) < 10 ? 2 : 1)
  }
}

/** "Sep 2026" for monthly/quarterly prints, "Nov 4" for daily/weekly. */
export function dateLabel(asOf: string, cadence: string): string {
  if (cadence === "monthly" || cadence === "quarterly") return `${MON[Number(asOf.slice(5, 7)) - 1]} ${asOf.slice(0, 4)}`
  return longDate(asOf).replace(/, \d{4}$/, "")
}

/** "about 50% above a normal October (usual range 1,100–1,530)" from the
 *  seasonal band (same history the votes use), or null without one. */
export function vsNormal(dial: Dial, rows: Reading[]): string | null {
  const v = valued(rows)
  const last = v[v.length - 1]
  if (!last) return null
  const band = seasonalBand(dial, last.as_of, v)
  if (!band || !band.mean) return null
  const pct = (last.value / band.mean - 1) * 100
  const month = longDate(last.as_of).split(" ")[0]
  const full = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][MON.indexOf(month)]
  const lo = Math.round(band.mean - band.sd)
  const hi = Math.round(band.mean + band.sd)
  const word = Math.abs(pct) < 5 ? "about normal for" : `about ${Math.round(Math.abs(pct))}% ${pct > 0 ? "above" : "below"} a normal`
  return `${word} ${full} (usual range ${lo.toLocaleString("en-US")}–${hi.toLocaleString("en-US")})`
}

/** % change vs the same month a year earlier (monthly level series). */
export function yearOverYear(rows: Reading[]): number | null {
  const v = valued(rows)
  const last = v[v.length - 1]
  if (!last) return null
  const ym = addMonths(last.as_of.slice(0, 7), -12)
  const prior = v.filter((r) => r.as_of.slice(0, 7) === ym).pop()
  return prior && prior.value ? (last.value / prior.value - 1) * 100 : null
}

/** % below the series' highest reading, and that reading's month. */
export function vsPeak(rows: Reading[], peak: { as_of: string; value: number } | null): { pct: number; month: string } | null {
  const v = valued(rows)
  const last = v[v.length - 1]
  const top = peak ?? (v.length ? v.reduce((m, r) => (r.value > m.value ? r : m), v[0]) : null)
  if (!last || !top || !top.value) return null
  return { pct: (last.value / top.value - 1) * 100, month: `${MON[Number(top.as_of.slice(5, 7)) - 1]} ${top.as_of.slice(0, 4)}` }
}

/** Timeline geometry: months from Oct 2026 to Dec 2028 → x in [0, 1]. */
export const TIMELINE = { start: "2026-10", end: "2028-12" }
export function timelineX(ym: string, edge: "start" | "end"): number {
  const idx = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1
  const span = idx(TIMELINE.end) - idx(TIMELINE.start) + 1
  const i = idx(ym) - idx(TIMELINE.start) + (edge === "end" ? 1 : 0)
  return Math.max(0, Math.min(1, i / span))
}
