import { longDate } from "./card"
import { betVotes, tripwireApplies } from "./bets"
import { DISPLAY } from "./display"
import { qualifyingBloc, seasonalBand, corridorSeries } from "./votes"
import { formatValue, previousReading, signTone, trend, type Tone } from "./view"
import { pendingTripwires } from "./schedule"
import type { BetDef, Dial, DialVote, Reading, ReviewState, Scenario } from "./types"

// "Latest numbers" on top of /cycle (Ryan 2026-11-19: "the page looks frozen").
// The odds move only at reviews; this shows what the collectors brought in
// since, at each source's real cadence, plus a live up/down count using the
// same votes the review uses (votes.ts). Pure: no React, no I/O.

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const TZ = "America/Los_Angeles"

const valued = (rows: Reading[] | undefined) => (rows ?? []).filter((r): r is Reading & { value: number } => r.value !== null)
const latest = (rows: Reading[] | undefined) => valued(rows).pop() ?? null
const num = (v: number, d = 0) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
const pctS = (v: number) => formatValue(v, "pct_signed")
const pct1 = (v: number) => `${num(v, Math.abs(v) < 10 ? 2 : 1).replace(/0$/, "")}%`
const below = (v: number) => `${Math.abs(v).toFixed(1)}% ${v < 0 ? "below" : "above"}`

// ---------------------------------------------------------------- freshness stamp
function ptParts(d: Date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]))
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
  return { day, weekday: p.weekday, date: `${p.month} ${p.day}, ${p.year}`, time: `${p.hour}:${p.minute} ${p.dayPeriod}`, hour: Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(d)) }
}

export interface CheckedStamp {
  text: string
  stale: boolean
}

/** "Checked this morning 6:31 AM" from the newest reading the collectors wrote.
 *  The daily collector writes a row every day (layoff 30-day count, Fed rate),
 *  weekends included, so the newest row is a heartbeat. Over 36 hours old =
 *  say so plainly. */
export function checkedStamp(latestWriteIso: string | null, now: Date = new Date()): CheckedStamp {
  if (!latestWriteIso) return { text: "No collector run on record yet", stale: true }
  const at = new Date(latestWriteIso)
  const hours = (now.getTime() - at.getTime()) / 3_600_000
  const a = ptParts(at)
  const n = ptParts(now)
  const yesterday = ptParts(new Date(now.getTime() - 86_400_000)).day
  if (hours > 36) return { text: `Last checked ${a.weekday}, ${a.date} ${a.time} — the mini may be down`, stale: true }
  if (a.day === n.day) return { text: `Checked ${a.hour < 12 ? "this morning" : "today"} ${a.time}`, stale: false }
  if (a.day === yesterday) return { text: `Checked yesterday ${a.time}`, stale: false }
  return { text: `Checked ${a.weekday}, ${a.date} ${a.time}`, stale: false }
}

// ---------------------------------------------------------------- signs (live votes)
/** What a voting dial's reading says, in plain words. `v` is the vote's own
 *  reading: the corridor read (10-day average, drawdown, …) or, for seasonal
 *  dials, the level itself. */
const SAYS: Record<string, (v: number) => string> = {
  cpi_yoy: (v) => `Inflation running ${num(v, 1)}% a year`,
  core_cpi_yoy: (v) => `Core inflation (CPI) ${num(v, 1)}% a year`,
  pce_yoy: (v) => `Inflation (PCE) ${num(v, 1)}% a year`,
  core_pce_yoy: (v) => `Core inflation (PCE) ${num(v, 1)}% a year`,
  unrate_us: (v) => `US unemployment ${pct1(v)}`,
  sahm_gap: (v) => `Recession alarm at ${num(v, 2)} (trips at 0.50)`,
  us_real_gdp_qoq: (v) => `US economy growing ${pct1(v)} a year`,
  ust10y: (v) => `10-year Treasury ${pct1(v)} (10-day average)`,
  ust2y: (v) => `2-year Treasury ${pct1(v)}`,
  curve_2s10s: (v) => `10-year minus 2-year Treasury ${v > 0 ? "+" : ""}${num(v, 2)}`,
  mortgage30: (v) => `Mortgage rate ${pct1(v)}`,
  mortgage_spread: (v) => `Mortgage rates ${num(v / 100, 2)} points over the 10-year`,
  brent: (v) => `Oil $${num(v)} a barrel (10-day average)`,
  ccc_oas: (v) => `Junk-bond risk premium ${num(v, 1)} points`,
  sp500: (v) => `S&P 500 ${below(v)} its Oct 6, 2026 high`,
  nasdaq: (v) => `Nasdaq ${below(v)} its Oct 6, 2026 high`,
  basket_index: (v) => `Bay Area tech employers' stocks ${below(v)} their 1-year high`,
  cs_national: (v) => `US home prices ${pctS(v)} vs a year ago`,
  fhfa_hpi_sj: (v) => `San Jose home prices (FHFA) ${pctS(v)} vs a year ago`,
  zhvi_scc_yoy: (v) => `Typical SCC home ${pctS(v)} vs a year ago`,
  zhvi_scc_drawdown: (v) => `Typical SCC home ${below(v)} the Jan 2025 peak`,
  zhvi_scc_top_yoy: (v) => `Top-tier home prices ${pctS(v)} vs a year ago`,
  zhvi_scc_bottom_yoy: (v) => `Lower-tier home prices ${pctS(v)} vs a year ago`,
  realtor_price_reduced_share_scc: (v) => `${num(v)}% of county listings have cut their price`,
  car_scc_sfr_median: (v) => `County median sale price ${pctS(v)} vs a year ago`,
  scc_months_supply: (v) => `${num(v, 1)} months of homes for sale`,
  scc_nod_count: (v) => `${num(v)} notices of default this week`,
  scc_unemployment: (v) => `County unemployment ${pct1(v)}`,
  sj_msa_nonfarm_yoy: (v) => `San Jose jobs ${pctS(v)} vs a year ago`,
  scc_warn_workers: (v) => `${num(v)} workers in layoff notices this month`,
  indeed_postings_sj: (v) => `San Jose job postings at ${num(v)} (Feb 2020 = 100)`,
  indeed_software_us: (v) => `Software job postings at ${num(v)} (Feb 2020 = 100)`,
  sj_rent_yoy: (v) => `San Jose rents ${pctS(v)} vs a year ago`,
  mls_scc_active_sfr: (v) => `${num(v)} houses for sale (our Monday count)`,
  mls_scc_new_listings_7d: (v) => `${num(v)} new listings this week`,
  mls_scc_price_cut_share: (v) => `${num(v, 1)}% of houses for sale have cut their price`,
  mls_scc_pending_ratio: (v) => `${num(v, 2)} houses in contract per house for sale`,
  mls_scc_median_dos: (v) => `Houses sitting ${num(v)} days on market`,
  mls_scc_withdrawn_share: (v) => `${num(v, 1)}% of listings withdrawn or relisted`,
  mls_scc_list_to_sale: (v) => `Houses selling at ${num(v, 1)}% of asking`,
}

/** Seasonal dials: a name, and the level as it reads in a sentence. */
const SEASONAL: Record<string, { name: string; value: (v: number) => string }> = {
  payrolls_mom: { name: "US jobs added", value: (v) => `${num(v)}k` },
  initial_claims_4wk: { name: "New jobless claims", value: (v) => `${num(v)} a week` },
  realtor_active_scc: { name: "County listings", value: (v) => num(v) },
  realtor_new_listings_scc: { name: "New county listings", value: (v) => num(v) },
  realtor_dom_scc: { name: "Days on market", value: (v) => num(v) },
  realtor_pending_ratio_scc: { name: "Homes going into contract", value: (v) => `${num(v, 2)} per listing` },
  realtor_price_reduced_scc: { name: "County listings with a price cut", value: (v) => num(v) },
  car_scc_sfr_sales: { name: "Closed house sales", value: (v) => num(v) },
}

function seasonalSays(dial: Dial, rows: Reading[], v: DialVote): string {
  const s = SEASONAL[dial.id]
  const name = s?.name ?? DISPLAY[dial.id]?.label ?? dial.name
  const value = s ? s.value(v.reading!.value) : formatValue(v.reading!.value, DISPLAY[dial.id]?.format ?? "num")
  const band = seasonalBand(dial, v.reading!.as_of, valued(rows))
  if (!band || !band.mean) return `${name} ${value}`
  const p = (v.reading!.value / band.mean - 1) * 100
  const month = MONTH_FULL[Number(v.reading!.as_of.slice(5, 7)) - 1]
  return Math.abs(p) < 5 ? `${name} ${value}, about normal for ${month}` : `${name} ${value}, about ${Math.round(Math.abs(p))}% ${p > 0 ? "above" : "below"} a normal ${month}`
}

/** One voting dial in plain English, e.g. "Top-tier home prices +3.1% vs a year ago". */
export function signLine(v: DialVote, dial: Dial | undefined, rows: Reading[]): string {
  if (!dial || !v.reading) return DISPLAY[v.dial_id]?.label ?? v.name
  if (dial.band_rule === "seasonal_1sd") return seasonalSays(dial, rows, v)
  const say = SAYS[dial.id]
  if (say) return say(v.reading.value)
  const d = DISPLAY[dial.id]
  return `${d?.label ?? dial.name.split(/[,(]/)[0].trim()} ${formatValue(v.reading.value, d?.format ?? "num")}`
}

export interface Sign {
  dialId: string
  text: string
  /** "Oct 2026" for monthly prints, "Nov 18, 2026" for daily/weekly. */
  when: string
}

export interface BetSigns {
  betId: string
  up: Sign[]
  down: Sign[]
  middle: Sign[]
  /** Past a line once, waiting on a second reading before they count. */
  leaningUp: string[]
  leaningDown: string[]
  /** One line: can the next review move the odds, and which way. */
  tilt: string
}

/** Month + year for monthly/quarterly prints (the as-of day is just a filing
 *  date there), month + day + year for daily/weekly. */
export function asOfLabel(asOf: string, cadence: Dial["cadence"]): string {
  if (cadence === "monthly" || cadence === "quarterly") return `${MON[Number(asOf.slice(5, 7)) - 1]} ${asOf.slice(0, 4)}`
  return longDate(asOf)
}

/** The live up/down count for one bet: the review's own votes (computeVotes),
 *  "up" = Bull (prices rising), "down" = Bear, "middle" = Base. The odds still
 *  move only at the review; this says whether it will have enough to. */
export function betSigns(bet: BetDef, allVotes: DialVote[], state: Pick<ReviewState, "dials" | "readings" | "tripwireEvents">, nextReview: string | null): BetSigns {
  const votes = betVotes(bet, allVotes)
  const dialById = new Map(state.dials.map((d) => [d.id, d]))
  const sign = (v: DialVote): Sign => {
    const dial = dialById.get(v.dial_id)
    return { dialId: v.dial_id, text: signLine(v, dial, state.readings[v.dial_id] ?? []), when: v.reading && dial ? asOfLabel(v.reading.as_of, dial.cadence) : "" }
  }
  const of = (s: Scenario) => votes.filter((v) => v.vote === s).map(sign)
  const leaning = (s: Scenario) => votes.filter((v) => v.vote === "none" && v.leaning === s).map((v) => signLine(v, dialById.get(v.dial_id), state.readings[v.dial_id] ?? []))
  const bull = qualifyingBloc(votes, "bull")
  const bear = qualifyingBloc(votes, "bear")
  const alarm = pendingTripwires(state.tripwireEvents).some((e) => tripwireApplies(bet, e))
  const review = nextReview ? `the ${nextReview} review` : "the next review"
  const at = ` at ${review}`
  let tilt: string
  if (bull.qualifies && bear.qualifies) tilt = `Both sides have enough votes — ${review} weighs them`
  else if (bull.qualifies) tilt = `Enough to tilt the odds toward Bull${at}`
  else if (bear.qualifies) tilt = `Enough to tilt the odds toward Bear${at}`
  else if (alarm) tilt = `An alarm went off — the odds can move${at}`
  else tilt = `Not enough to move the odds yet — that takes 3 signs from 2 different areas`
  return { betId: bet.id, up: of("bull"), down: of("bear"), middle: of("base"), leaningUp: leaning("bull"), leaningDown: leaning("bear"), tilt }
}

// ---------------------------------------------------------------- numbers by cadence
export interface LatestItem {
  id: string
  label: string
  value: string
  /** Short gray line: change since last time, distance from a line, … */
  note: string | null
  tone: Tone
  when: string
  /** A weekly/monthly print that arrived in the last 7 days. */
  fresh: boolean
}

export interface LatestGroup {
  cadence: "daily" | "weekly" | "monthly"
  title: string
  items: LatestItem[]
}

type ItemSpec = {
  id: string
  label: string
  /** Value text; default = the dial's display format. */
  value?: (v: number, rows: Reading[], dial: Dial) => string
  note?: (v: number, rows: Reading[], dial: Dial, prev: { as_of: string; value: number } | null) => string | null
  /** Colour by the number itself (change numbers), not the move since last time. */
  toneByValue?: boolean
  /** Colour by where it sits against a normal month (seasonal dials). */
  toneByNormal?: boolean
}

const drawdownFromAnchor = (rows: Reading[], dial: Dial) => {
  const s = corridorSeries({ ...dial, corridor: { transform: (dial.corridor ?? {}).transform } }, rows)
  return s.length ? s[s.length - 1].value : null
}
const was = (fmt: (v: number) => string, period: string) => (_v: number, _r: Reading[], _d: Dial, prev: { value: number } | null) => (prev ? `was ${fmt(prev.value)} ${period}` : null)

const SPECS: Record<"daily" | "weekly" | "monthly", ItemSpec[]> = {
  daily: [
    { id: "sp500", label: "S&P 500", value: (v) => num(v), note: (_v, rows, d) => { const dd = drawdownFromAnchor(rows, d); return dd === null ? null : `${below(dd)} its Oct 6, 2026 high · alarm at 10% below` } },
    { id: "nasdaq", label: "Nasdaq", value: (v) => num(v), note: (_v, rows, d) => { const dd = drawdownFromAnchor(rows, d); return dd === null ? null : `${below(dd)} its Oct 6, 2026 high` } },
    { id: "ust10y", label: "10-year Treasury", note: was(pct1, "the day before") },
    { id: "ccc_oas", label: "Junk-bond risk premium", value: (v) => `${num(v, 2)} pts`, note: () => "Extra interest the riskiest companies pay · alarm at 20" },
  ],
  weekly: [
    { id: "mls_scc_active_sfr", label: "Houses for sale (our Monday count)", note: was((x) => num(x), "last week") },
    { id: "mls_scc_new_listings_7d", label: "New listings this week", note: was((x) => num(x), "last week") },
    // The share is "below the first price we saw", so it climbs as our record gets longer:
    // the honest week's number is how many cut this week (raw.cut_wow), not the change in share.
    { id: "mls_scc_price_cut_share", label: "Houses that have cut their price", value: (v) => `${num(v, 1)}%`, note: (_v, rows) => priceCutNote(rows) },
    { id: "mortgage30", label: "Mortgage rate (30-year)", note: was(pct1, "last week") },
    { id: "initial_claims_4wk", label: "New jobless claims (4-week avg)", note: was((x) => num(x), "last week"), toneByNormal: true },
  ],
  monthly: [
    { id: "zhvi_scc_drawdown", label: "Typical SCC house vs Jan 2025 peak", value: (v) => pctS(v), toneByValue: true, note: (_v, _r, _d, prev) => (prev ? `was ${pctS(prev.value)} the month before` : null) },
    { id: "realtor_active_scc", label: "County listings (Realtor.com)", value: (v) => num(v), note: (_v, rows, d) => normalNote(d, rows)?.text ?? null, toneByNormal: true },
    { id: "realtor_pending_ratio_scc", label: "In contract per listing", value: (v) => num(v, 2), note: (_v, rows, d) => normalNote(d, rows)?.text ?? null, toneByNormal: true },
    { id: "realtor_price_reduced_share_scc", label: "County listings with a price cut", value: (v) => `${num(v, 1)}%`, note: was((x) => `${num(x, 1)}%`, "the month before") },
    { id: "sj_msa_nonfarm_yoy", label: "San Jose jobs vs a year ago", value: (v) => pctS(v), toneByValue: true },
    { id: "sj_rent_yoy", label: "San Jose rents vs a year ago", value: (v) => pctS(v), toneByValue: true },
    { id: "scc_warn_workers_30d", label: "Layoff notices, last 30 days", value: (v) => `${num(v)} workers`, note: () => "alarm at 1,588 in a month" },
    { id: "cpi_yoy", label: "Inflation (CPI)", value: (v) => `${num(v, 1)}% a year`, note: was((x) => `${num(x, 1)}%`, "the month before") },
  ],
}

function normalNote(dial: Dial, rows: Reading[]): { text: string; tone: Tone } | null {
  const last = latest(rows)
  if (!last) return null
  const band = seasonalBand(dial, last.as_of, valued(rows))
  if (!band || !band.mean) return null
  const p = (last.value / band.mean - 1) * 100
  const month = MONTH_FULL[Number(last.as_of.slice(5, 7)) - 1]
  if (Math.abs(p) < 5) return { text: `about normal for ${month}`, tone: "flat" }
  const side = dial.direction_map[p > 0 ? "up" : "down"]
  return { text: `about ${Math.round(Math.abs(p))}% ${p > 0 ? "above" : "below"} a normal ${month}`, tone: side === "bull" ? "good" : side === "bear" ? "bad" : "flat" }
}

function parseRaw(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>
  if (typeof raw !== "string") return null
  try {
    const o = JSON.parse(raw)
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** "81 cut it this week · counting since Nov 2, 2026" from the weekly snapshot's raw counts. */
export function priceCutNote(rows: Reading[]): string | null {
  const v = valued(rows)
  const last = v[v.length - 1]
  if (!last) return null
  const raw = parseRaw(last.raw)
  const wow = raw && typeof raw.cut_wow === "number" ? raw.cut_wow : null
  const since = v[0]?.as_of
  return [wow !== null ? `${num(wow)} cut it this week` : null, since ? `counting since ${longDate(since)}` : null].filter(Boolean).join(" · ") || null
}

const TITLE = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" } as const

/** The handful of numbers per cadence that matter, each with its own date.
 *  `today` (YYYY-MM-DD, Pacific) decides what counts as newly arrived. */
export function latestGroups(state: Pick<ReviewState, "dials" | "readings">, today: string): LatestGroup[] {
  const dialById = new Map(state.dials.map((d) => [d.id, d]))
  const freshSince = Date.parse(today + "T00:00:00Z") - 7 * 86_400_000
  return (["daily", "weekly", "monthly"] as const).map((cadence) => ({
    cadence,
    title: TITLE[cadence],
    items: SPECS[cadence].flatMap((s): LatestItem[] => {
      const dial = dialById.get(s.id)
      const rows = state.readings[s.id] ?? []
      const last = latest(rows)
      if (!dial || !last) return []
      const fmt = DISPLAY[s.id]?.format ?? "num"
      const prev = previousReading(dial, rows)
      const tone: Tone = s.toneByValue ? signTone(dial, last.value) : s.toneByNormal ? (normalNote(dial, rows)?.tone ?? "flat") : trend(dial, rows, fmt, DISPLAY[s.id]?.context).tone
      const created = last.created_at ? Date.parse(last.created_at) : NaN
      return [
        {
          id: s.id,
          label: s.label,
          value: s.value ? s.value(last.value, rows, dial) : formatValue(last.value, fmt),
          note: s.note ? s.note(last.value, rows, dial, prev) : null,
          tone,
          when: asOfLabel(last.as_of, dial.cadence),
          fresh: dial.cadence !== "daily" && Number.isFinite(created) && created >= freshSince,
        },
      ]
    }),
  })).filter((g) => g.items.length)
}

/** Alarm (tripwire) status: anything waiting for a review, else the last one that went off. */
export function alarmLine(state: Pick<ReviewState, "tripwireEvents">): { value: string; note: string; tone: Tone } {
  const pending = pendingTripwires(state.tripwireEvents)
  if (pending.length) {
    const first = [...pending].sort((a, b) => b.fired_on.localeCompare(a.fired_on))[0]
    return { value: `${pending.length} went off`, note: `waiting for a review · latest ${longDate(first.fired_on)}`, tone: "bad" }
  }
  const last = [...state.tripwireEvents].sort((a, b) => b.fired_on.localeCompare(a.fired_on))[0]
  return { value: "Quiet", note: last ? `none going off · last one ${longDate(last.fired_on)}, reviewed` : "none going off", tone: "flat" }
}
