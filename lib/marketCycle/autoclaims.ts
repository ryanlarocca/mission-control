import { corridorSeries } from "./votes"
import type { AutoRule, Claim, ClaimUpdate, Dial, Reading } from "./types"

// Data-decidable claims resolve by code, not by the model (Ryan 2026-11-07, Q4:
// "otherwise the scorecard isn't one"). Each rule lives on the claim in the
// thesis config (`auto`). Pure.
//   any     true the first time `value op threshold` holds inside [from, to];
//           false once the claim's resolves_on date has passed without it
//   all     false the first time it fails inside [from, to]; true once
//           resolves_on has passed (needs ≥1 reading in the window)
//   at      one print (month): decided at resolves_on (prints get revised)
//   low_in  the window's lowest reading falls in [low_from, low_to] and the
//           window's last reading is above it: decided at resolves_on
// Window bounds are months (YYYY-MM, matched on the as_of month) or days.

export interface AutoVerdict {
  value: boolean
  /** The reading date that decided it (or the resolution date). */
  on: string
  reason: string
}

const OPS: Record<NonNullable<AutoRule["op"]>, (a: number, b: number) => boolean> = {
  lt: (a, b) => a < b,
  le: (a, b) => a <= b,
  gt: (a, b) => a > b,
  ge: (a, b) => a >= b,
}
const OP_TEXT: Record<NonNullable<AutoRule["op"]>, string> = { lt: "<", le: "≤", gt: ">", ge: "≥" }

const key = (asOf: string, bound: string) => (bound.length === 7 ? asOf.slice(0, 7) : asOf.slice(0, 10))
const fmt = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 100) / 100))

/** The series a rule reads: the dial's base readings, or a transform of them
 *  (e.g. drawdown from a dated high), ascending. */
export function ruleSeries(rule: AutoRule, dial: Dial | undefined, readings: Reading[]): { as_of: string; value: number }[] {
  const rows = readings.filter((r): r is Reading & { value: number } => r.value !== null).sort((a, b) => a.as_of.localeCompare(b.as_of))
  if (!rule.transform) return rows.map((r) => ({ as_of: r.as_of, value: r.value }))
  const base: Dial = dial ?? { id: rule.dial, name: rule.dial, cadence: "daily", category: "", band_rule: "corridor", direction_map: {}, corridor: null, votes: false, has_history: true, transform: "level" }
  return corridorSeries({ ...base, corridor: { transform: rule.transform } }, rows)
}

export function autoResolve(claim: Pick<Claim, "id" | "resolves_on" | "status">, rule: AutoRule, dial: Dial | undefined, readings: Reading[], today: string): AutoVerdict | null {
  if (claim.status !== "open") return null
  const series = ruleSeries(rule, dial, readings)
  const due = today >= claim.resolves_on
  const thr = rule.threshold ?? 0
  const op = rule.op ? OPS[rule.op] : null
  const cond = rule.op ? `${rule.dial}${rule.transform ? ` (${rule.transform})` : ""} ${OP_TEXT[rule.op]} ${fmt(thr)}` : ""
  const inWin = (asOf: string, from?: string, to?: string) => (!from || key(asOf, from) >= from) && (!to || key(asOf, to) <= to)
  const win = series.filter((r) => inWin(r.as_of, rule.from, rule.to))

  if (rule.rule === "any" && op) {
    const hit = win.find((r) => op(r.value, thr))
    if (hit) return { value: true, on: hit.as_of, reason: `auto: ${cond} on ${hit.as_of} (${fmt(hit.value)})` }
    return due ? { value: false, on: today, reason: `auto: ${cond} never held ${rule.from ?? ""}–${rule.to ?? ""} (${win.length} readings)` } : null
  }
  if (rule.rule === "all" && op) {
    const miss = win.find((r) => !op(r.value, thr))
    if (miss) return { value: false, on: miss.as_of, reason: `auto: ${cond} broke on ${miss.as_of} (${fmt(miss.value)})` }
    return due && win.length ? { value: true, on: today, reason: `auto: ${cond} held for all ${win.length} readings ${rule.from ?? ""}–${rule.to ?? ""}` } : null
  }
  if (rule.rule === "at" && op && rule.month) {
    if (!due) return null
    const r = series.filter((x) => x.as_of.slice(0, 7) === rule.month).pop()
    if (!r) return null
    return { value: op(r.value, thr), on: r.as_of, reason: `auto: ${rule.month} print ${fmt(r.value)} ${op(r.value, thr) ? "" : "not "}${OP_TEXT[rule.op!]} ${fmt(thr)}` }
  }
  if (rule.rule === "low_in" && rule.low_from && rule.low_to) {
    if (!due || win.length < 2) return null
    const low = win.reduce((m, r) => (r.value < m.value ? r : m), win[0])
    const last = win[win.length - 1]
    const inLow = inWin(low.as_of, rule.low_from, rule.low_to)
    const above = last.value > low.value
    return {
      value: inLow && above,
      on: today,
      reason: `auto: lowest ${fmt(low.value)} on ${low.as_of} (${inLow ? "inside" : "outside"} ${rule.low_from}–${rule.low_to}); last ${fmt(last.value)} on ${last.as_of} ${above ? "above" : "not above"} it`,
    }
  }
  return null
}

/** Resolutions decided by code for these claims today, as claim updates. */
export function autoClaimUpdates(claims: Claim[], rules: (id: string) => AutoRule | null, dials: Dial[], readings: Record<string, Reading[]>, today: string): ClaimUpdate[] {
  const byId = new Map(dials.map((d) => [d.id, d]))
  return claims.flatMap((c) => {
    const rule = rules(c.id)
    if (!rule) return []
    const v = autoResolve(c, rule, byId.get(rule.dial), readings[rule.dial] ?? [], today)
    return v ? [{ id: c.id, action: "resolve" as const, value: v.value, reason: v.reason }] : []
  })
}
