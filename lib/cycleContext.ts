// Market-cycle tracker — the macro-context block for comps
// (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md §3.7). A line-for-line port of
// scripts/market-cycle/cycle-context.py so a cloud agent can GET the same block
// from /api/cycle/context; tests/market-cycle-context.unit.test.ts renders the
// shared fixture through both and requires identical text. Change one, change both.
// Context, never a substitute for pocket comps. Missing data prints
// "n/a (no reading yet)"; nothing is filled in.
import type { SupabaseClient } from "@supabase/supabase-js"
import thesis from "@/config/market-cycle/thesis.v1.1.json"

export const NA = "n/a (no reading yet)"
export const CONTEXT_LABEL = "MACRO CONTEXT (market-cycle tracker) — context, not comps"
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const DEFAULT_TROUGH: Record<string, string> = { bull: "2027-01", base: "2027-05", bear: "2028-06" }
const QUARTERLY_MONTHS = [2, 5, 8, 11]
const NAMES: Record<string, string> = { bear: "Bear", base: "Base", bull: "Bull" }

export type Reading = [string, number | null]
export type CycleContextData = {
  today?: string
  readings?: Record<string, Reading[]>
  weight_move?: { date: string; to_weights: Record<string, number> } | null
  checkpoint?: { date: string; kind?: string | null; weights_after?: Record<string, number> | null; argument?: string | null } | null
  calendar?: Array<{ date: string | null; label?: string; dial_id?: string | null }>
}
type Scenario = { id: string; weight: number; drawdown_bounds_pct: { min: number | null; max: number | null }; trough_month?: string }
type Tier = { id: string; label: string; min: number | null; max: number | null }
export type CycleConfig = {
  version: string
  scenarios: Scenario[]
  scored_object: { reference_peak: { month: string; value: number }; historical_drawdowns_same_series: Record<string, number> }
  geographies: { tiers: Tier[] }
  checkpoint_schedule: { shakedown: string; first_formal: string }
  calendar: Array<{ date: string; dial_id: string | null }>
}
export const THESIS = thesis as unknown as CycleConfig

// ---------------------------------------------------------------- formatting (mirrors the Python exactly)
export function fnum(x: number, d = 1): string {
  const neg = x < 0
  let s = Math.abs(x).toFixed(d) // exact-binary, ties away from zero = Python Decimal ROUND_HALF_UP
  if (neg) s = "-" + s
  if (/^-0(\.0+)?$/.test(s)) s = s.slice(1)
  return s
}
export function fint(x: number): string {
  let s = fnum(x, 0)
  const neg = s.startsWith("-")
  s = s.replace(/^-/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return (neg ? "-" : "") + s
}
export function fsigned(x: number, d = 1): string {
  let s = fnum(x, d)
  if (!s.startsWith("-") && Number(s) !== 0) s = "+" + s
  return s + "%"
}
export function fmoney(v: number): string {
  if (v >= 1e6) return "$" + fnum(v / 1e6, 2) + "M"
  if (v >= 1e3) return "$" + fnum(v / 1e3, 0) + "k"
  return "$" + fint(v)
}
export function dateLabel(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${Number(iso.slice(0, 4))}`
}
export function monthLabel(ym: string): string {
  return `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${Number(ym.slice(0, 4))}`
}

// ---------------------------------------------------------------- series helpers
const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1
export function shiftMonth(ym: string, k: number): string {
  const i = monthIndex(ym) + k
  return `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`
}
type Row = [string, number]
function series(data: CycleContextData, dial: string): Row[] {
  const rows = ((data.readings || {})[dial] || []).filter((r): r is Row => !!r && r[1] !== null && r[1] !== undefined)
  return [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}
function latest(data: CycleContextData, dial: string): Row | null {
  const s = series(data, dial)
  return s.length ? s[s.length - 1] : null
}
function monthsBack(s: Row[], k: number): Row | null {
  if (!s.length) return null
  const want = shiftMonth(s[s.length - 1][0].slice(0, 7), -k)
  const hit = s.filter((r) => r[0].slice(0, 7) === want)
  return hit.length ? hit[hit.length - 1] : null
}
const dayNum = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000
function nearDaysBack(s: Row[], days: number, tol: number): Row | null {
  if (!s.length) return null
  const last = s[s.length - 1][0]
  let best: [number, Row] | null = null
  for (const r of s.slice(0, -1)) {
    const off = Math.abs(dayNum(last) - dayNum(r[0]) - days)
    if (off <= tol && (best === null || off < best[0])) best = [off, r]
  }
  return best ? best[1] : null
}
const pctChange = (n: number, o: number) => (n / o - 1) * 100

// ---------------------------------------------------------------- pieces
function weightsPart(data: CycleContextData, cfg: CycleConfig): string {
  const wm = data.weight_move
  const cp = data.checkpoint
  let w: Record<string, number>
  let src: string
  if (wm && wm.to_weights) {
    w = wm.to_weights
    src = "weight log, " + dateLabel(wm.date)
  } else if (cp && cp.weights_after) {
    w = cp.weights_after
    src = "checkpoint, " + dateLabel(cp.date)
  } else {
    w = Object.fromEntries(cfg.scenarios.map((s) => [s.id, s.weight]))
    src = "thesis v" + cfg.version
  }
  const parts = ["bear", "base", "bull"].map((k) => `${NAMES[k]} ${w[k] !== undefined && w[k] !== null ? fnum(w[k], 0) : "n/a"}`)
  return "Weights: " + parts.join(" · ") + " (" + src + ")"
}

export type Drawdown = { today: number; deepest: number; month: string }
export function drawdownState(data: CycleContextData, cfg: CycleConfig): Drawdown | null {
  const ref = cfg.scored_object.reference_peak
  const s = series(data, "zhvi_scc").filter((r) => r[0].slice(0, 7) >= ref.month)
  if (!s.length) return null
  const dds = s.map(([, v]) => pctChange(v, ref.value))
  return { today: dds[dds.length - 1], deepest: Math.min(0, Math.min(...dds)), month: s[s.length - 1][0].slice(0, 7) }
}
function bounds(cfg: CycleConfig, id: string) {
  return cfg.scenarios.find((s) => s.id === id)!.drawdown_bounds_pct
}
function bands(cfg: CycleConfig, deepest: number): Record<string, [number, number]> {
  const floor = Math.min(...Object.values(cfg.scored_object.historical_drawdowns_same_series))
  return {
    bear: [floor, bounds(cfg, "bear").max as number],
    base: [bounds(cfg, "base").min as number, bounds(cfg, "base").max as number],
    bull: [bounds(cfg, "bull").min as number, deepest],
  }
}
function partitionPart(dd: Drawdown | null, cfg: CycleConfig): string {
  if (!dd) return "partition: " + NA
  const bearAt = bounds(cfg, "bear").max as number
  const bullFloor = bounds(cfg, "bull").min as number
  const head = `SCC ZHVI ${fsigned(dd.today)} vs ${monthLabel(cfg.scored_object.reference_peak.month)} peak (${monthLabel(dd.month)}), deepest ${fsigned(dd.deepest)}`
  let where: string
  if (dd.deepest <= bearAt) where = "Bear band reached"
  else if (dd.deepest <= bullFloor) where = `Base band reached, Bull ruled out (Bear at ${fsigned(bearAt, 0)})`
  else where = `inside the Bull band so far (Base at ${fsigned(bullFloor, 0)}, Bear at ${fsigned(bearAt, 0)})`
  return head + " → " + where
}
function val(data: CycleContextData, dial: string, fmt: (x: number) => string): string | null {
  const r = latest(data, dial)
  return r ? fmt(r[1]) : null
}
const pctPlain = (x: number) => fnum(x, 1) + "%"
const days = (x: number) => fint(x) + "d"
const ppsf = (x: number) => "$" + fint(x) + "/sf"

function countyLine(data: CycleContextData): string {
  let zy = val(data, "zhvi_scc_yoy", (x) => fsigned(x))
  if (zy === null) {
    const s = series(data, "zhvi_scc")
    const prev = monthsBack(s, 12)
    zy = prev ? fsigned(pctChange(s[s.length - 1][1], prev[1])) : null
  }
  let act: string | null = null
  let s = series(data, "mls_scc_active_sfr")
  let prev = nearDaysBack(s, 364, 4)
  if (prev) act = fsigned(pctChange(s[s.length - 1][1], prev[1]), 0)
  else {
    s = series(data, "realtor_active_scc")
    prev = monthsBack(s, 12)
    if (prev) act = fsigned(pctChange(s[s.length - 1][1], prev[1]), 0) + " (Realtor.com)"
  }
  let dos = val(data, "mls_scc_median_dos", days)
  if (dos === null) dos = val(data, "realtor_dom_scc", (x) => days(x) + " (Realtor.com DOM)")
  let cut = val(data, "mls_scc_price_cut_share", pctPlain)
  if (cut === null) cut = val(data, "realtor_price_reduced_share_scc", (x) => pctPlain(x) + " (Realtor.com)")
  const lts = val(data, "mls_scc_list_to_sale", pctPlain)
  const [a, b, c, d, e] = [zy, act, dos, cut, lts].map((x) => (x !== null ? x : NA))
  return `County (SCC): ZHVI YoY ${a} · actives YoY ${b} · days on site ${c} · price-cut share ${d} · list-to-sale ${e}`
}
export function tierFor(cfg: CycleConfig, price: number): Tier | null {
  return cfg.geographies.tiers.find((t) => (t.min === null || price >= t.min) && (t.max === null || price < t.max)) || null
}
function localParts(data: CycleContextData, prefix: string): string[] {
  const parts = [
    "actives " + (val(data, prefix + "_active_sfr", fint) || NA),
    "days on site " + (val(data, prefix + "_median_dos", days) || NA),
    "cut share " + (val(data, prefix + "_price_cut_share", pctPlain) || NA),
  ]
  const sold = val(data, prefix + "_sold_ppsf_90d", ppsf)
  if (sold) parts.push("sold 90d " + sold)
  return parts
}
function tierLine(data: CycleContextData, cfg: CycleConfig, price: number): string {
  const t = tierFor(cfg, price)
  if (!t) return "Tier: " + NA
  return `Tier ${t.label} (SCC): ${localParts(data, "mls_scc_tier_" + t.id).join(" · ")}`
}
function zipLine(data: CycleContextData, zip: string): string {
  const parts = localParts(data, "mls_zip_" + zip)
  parts.push("ZHVI YoY " + (val(data, "zhvi_zip_" + zip, (x) => fsigned(x)) || NA))
  return `Zip ${zip}: ${parts.join(" · ")}`
}
function driftLine(data: CycleContextData, zip: string): string {
  let s = series(data, `zhvi_zip_${zip}_level`)
  let label = `zip ${zip} ZHVI`
  if (!s.length) {
    s = series(data, "zhvi_scc")
    label = "county ZHVI, no zip level series yet"
  }
  if (!s.length) return "Stale-comp drift: " + NA
  const last = s[s.length - 1][1]
  const p60 = monthsBack(s, 2)
  const p90 = monthsBack(s, 3)
  const d60 = p60 ? fsigned(pctChange(last, p60[1])) : NA
  const d90 = p90 ? fsigned(pctChange(last, p90[1])) : NA
  const tail = p90 ? ` → a comp sold 90 days ago: index moved ${d90} since` : ""
  return `Stale-comp drift (${label}; latest print ${monthLabel(s[s.length - 1][0].slice(0, 7))}): 60d ${d60} · 90d ${d90}${tail}`
}
/** [scenario id, move % vs today | null, ruled out]. See the Python module docstring for the approximation. */
export function exitPath(dd: Drawdown, cfg: CycleConfig, exitMonth: string): Array<[string, number | null, boolean]> {
  const bb = bands(cfg, dd.deepest)
  return cfg.scenarios.map((sc): [string, number | null, boolean] => {
    const [lo, hi] = bb[sc.id]
    if (sc.id !== "bear" && dd.deepest <= lo) return [sc.id, null, true]
    const mid = (lo + hi) / 2
    const trough = sc.trough_month || DEFAULT_TROUGH[sc.id]
    const span = monthIndex(trough) - monthIndex(dd.month)
    const gone = monthIndex(exitMonth) - monthIndex(dd.month)
    const frac = span <= 0 ? 1.0 : Math.max(0.0, Math.min(1.0, gone / span))
    const ddExit = dd.today + (mid - dd.today) * frac
    const move = ((1 + ddExit / 100) / (1 + dd.today / 100) - 1) * 100
    return [sc.id, move, false]
  })
}
function exitLine(data: CycleContextData, cfg: CycleConfig, price: number, exitMonth: string): string {
  const dd = drawdownState(data, cfg)
  const head = `Exit ${monthLabel(exitMonth)}`
  if (!dd) return head + ": " + NA
  const t = tierFor(cfg, price)
  const parts = exitPath(dd, cfg, exitMonth).map(([sid, move, out]) =>
    out || move === null ? `${NAMES[sid]} ruled out` : `${NAMES[sid]} ${fsigned(move)} (~${fmoney(price * (1 + move / 100))})`
  )
  return `${head} (${t ? t.label : "tier"} ≈ county; straight line from today's ${fsigned(dd.today)} to each band's midpoint by its typical trough, flat after): ${parts.join(" · ")}`
}
export function nextCheckpoint(data: CycleContextData, cfg: CycleConfig, today: string): [string | null, string | null] {
  const sch = cfg.checkpoint_schedule
  if (today <= sch.shakedown) return [sch.shakedown, "shakedown"]
  if (today <= sch.first_formal) return [sch.first_formal, "first formal review"]
  const cal = data.calendar && data.calendar.length ? data.calendar : cfg.calendar.map((c) => ({ date: c.date, dial_id: c.dial_id }))
  const cpi = cal.filter((c) => c.dial_id === "cpi_yoy" && c.date && /^\d{4}-\d{2}-\d{2}$/.test(c.date)).map((c) => c.date as string).sort()
  for (const d of cpi) {
    const x = new Date(d + "T00:00:00Z")
    const weekday = (x.getUTCDay() + 6) % 7 // Monday = 0, as Python's weekday()
    const add = (7 - weekday) % 7 || 7
    const monday = new Date(x.getTime() + add * 86_400_000).toISOString().slice(0, 10)
    if (monday >= today) return [monday, QUARTERLY_MONTHS.includes(Number(monday.slice(5, 7))) ? "quarterly" : "monthly"]
  }
  return [null, null]
}
function oneLiner(text: string | null | undefined, n = 110): string {
  let t = String(text || "").replace(/\s+/g, " ").trim()
  const m = /^(.+?[.!?])(\s|$)/.exec(t)
  t = m ? m[1] : t
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + "…"
}
function checkpointLine(data: CycleContextData, cfg: CycleConfig, today: string): string {
  const cp = data.checkpoint
  const last = cp ? `Last checkpoint ${dateLabel(cp.date)} (${cp.kind || "?"}): ${oneLiner(cp.argument) || "no argument stored"}` : "Last checkpoint: n/a (none yet)"
  const [d, kind] = nextCheckpoint(data, cfg, today)
  return last + " · Next: " + (d ? `${dateLabel(d)} (${kind})` : "n/a (no CPI date on the calendar)")
}

/** The ≤10-line block. Pure. */
export function renderCycleContext(
  data: CycleContextData,
  { zip, price, exitMonth = null, today = null }: { zip: string; price: number; exitMonth?: string | null; today?: string | null },
  cfg: CycleConfig = THESIS
): string[] {
  const day = today || data.today || new Date().toISOString().slice(0, 10)
  const dd = drawdownState(data, cfg)
  const lines = [
    `${CONTEXT_LABEL} · zip ${zip} · ${fmoney(price)} · as of ${dateLabel(day)}`,
    weightsPart(data, cfg) + " | " + partitionPart(dd, cfg),
    countyLine(data),
    tierLine(data, cfg, price),
    zipLine(data, zip),
    driftLine(data, zip),
  ]
  if (exitMonth) lines.push(exitLine(data, cfg, price, exitMonth))
  lines.push(checkpointLine(data, cfg, day))
  return lines.slice(0, 10)
}

// ---------------------------------------------------------------- Supabase (reads only)
export function contextDials(cfg: CycleConfig, zip: string, price: number): string[] {
  const ids = ["zhvi_scc", "zhvi_scc_yoy", "realtor_active_scc", "realtor_dom_scc", "realtor_price_reduced_share_scc",
    "mls_scc_active_sfr", "mls_scc_median_dos", "mls_scc_price_cut_share", "mls_scc_list_to_sale",
    "zhvi_zip_" + zip, `zhvi_zip_${zip}_level`]
  const t = tierFor(cfg, price)
  for (const prefix of [...(t ? ["mls_scc_tier_" + t.id] : []), "mls_zip_" + zip]) {
    for (const m of ["_active_sfr", "_median_dos", "_price_cut_share", "_sold_ppsf_90d"]) ids.push(prefix + m)
  }
  return ids
}

export async function loadCycleContextData(client: SupabaseClient, zip: string, price: number, today: string, cfg: CycleConfig = THESIS): Promise<CycleContextData> {
  const readings: Record<string, Reading[]> = {}
  await Promise.all(contextDials(cfg, zip, price).map(async (d) => {
    const { data, error } = await client.from("cycle_readings").select("as_of, value").eq("dial_id", d).lte("as_of", today).order("as_of", { ascending: false }).limit(60)
    if (error) throw new Error(`cycle_readings ${d}: ${error.message}`)
    if (data && data.length) readings[d] = data.slice().reverse().map((r) => [String(r.as_of), r.value === null ? null : Number(r.value)] as Reading)
  }))
  const wm = await client.from("cycle_weight_moves").select("date, to_weights").order("date", { ascending: false }).order("id", { ascending: false }).limit(1)
  if (wm.error) throw new Error(`cycle_weight_moves: ${wm.error.message}`)
  const cp = await client.from("cycle_checkpoints").select("date, kind, weights_after, argument").lte("date", today).order("date", { ascending: false }).order("created_at", { ascending: false }).limit(1)
  if (cp.error) throw new Error(`cycle_checkpoints: ${cp.error.message}`)
  const since = shiftMonth(today.slice(0, 7), -1) + "-01"
  const cal = await client.from("cycle_calendar").select("date, label, dial_id").gte("date", since).order("date", { ascending: true }).limit(100)
  if (cal.error) throw new Error(`cycle_calendar: ${cal.error.message}`)
  return {
    today,
    readings,
    weight_move: (wm.data?.[0] as CycleContextData["weight_move"]) || null,
    checkpoint: (cp.data?.[0] as CycleContextData["checkpoint"]) || null,
    calendar: (cal.data || []) as CycleContextData["calendar"],
  }
}
