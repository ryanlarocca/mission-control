// The Board — 90-day goal & rep tracker: types, quotas, and every derived
// stat as a pure function over board_events rows. All date math is done on
// YYYY-MM-DD strings pinned to UTC noon so it is immune to the server/client
// timezone and to DST transitions; "today" is always the CLIENT's local
// calendar day (see localDateKey), which the client passes to the API.

export type Bucket = "agent" | "seller" | "referral_partner"
export type PaOutcome = "1B" | "2B" | "3B" | "HR" | "BB" | "SF" | "K" | "OUT"
export type BoardEventType =
  | "contact_touch"
  | "offer"
  | "appointment"
  | "draft"
  | "dg_round"
  | "dg_practice"
  | "cage"
  | "softball_game"

export const BUCKETS: Bucket[] = ["agent", "seller", "referral_partner"]
export const PA_OUTCOMES: PaOutcome[] = ["1B", "2B", "3B", "HR", "BB", "SF", "K", "OUT"]
export const EVENT_TYPES: BoardEventType[] = [
  "contact_touch", "offer", "appointment", "draft", "dg_round", "dg_practice", "cage", "softball_game",
]

export interface BoardPeriod {
  id: string
  label: string
  starts_on: string // YYYY-MM-DD
  ends_on: string   // YYYY-MM-DD
}

export interface BoardEvent {
  id: string
  period_id: string
  event_type: BoardEventType
  occurred_on: string // YYYY-MM-DD
  payload: Record<string, unknown>
  relationship_id: string | null
  created_at: string
}

export const QUOTAS = {
  // 2026-07-17: 10/day → 5/day — five solid conversations beat ten loose
  // ones (post-Cleanup the queue is only people Ryan chose to keep).
  contactsPerDay: 5,
  contactsPerWeek: 25,
  appointmentsPerWeek: 2,
  offersPerWeek: 1,
  offersPer90: 12,
  offersFloor: 7,
  draftsPerDay: 1,
  draftsPerWeek: 7,
  dgRoundsPerWeek: 5,
  dgPracticesPerWeek: 2,
  cagesPerWeek: 1,
} as const

// ---------- date math (YYYY-MM-DD strings, UTC-noon anchored) ----------

const DAY_MS = 86_400_000

function toUtcNoon(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00Z`)
}

function fromUtcNoon(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** The calendar day where the user is sitting (local tz), as YYYY-MM-DD. */
export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function addDays(dateKey: string, n: number): string {
  return fromUtcNoon(new Date(toUtcNoon(dateKey).getTime() + n * DAY_MS))
}

/** Whole calendar days from a to b (positive when b is after a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcNoon(b).getTime() - toUtcNoon(a).getTime()) / DAY_MS)
}

/** Monday of the week containing dateKey (weeks start Monday). */
export function mondayOf(dateKey: string): string {
  const d = toUtcNoon(dateKey)
  const dow = (d.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  return addDays(dateKey, -dow)
}

export function inSameWeek(dateKey: string, refKey: string): boolean {
  return mondayOf(dateKey) === mondayOf(refKey)
}

/** Days remaining in the block: 90 on day one, 0 on ends_on and after. */
export function daysRemaining(period: Pick<BoardPeriod, "ends_on">, todayKey: string): number {
  return Math.max(0, daysBetween(todayKey, period.ends_on))
}

export function inPeriod(dateKey: string, period: Pick<BoardPeriod, "starts_on" | "ends_on">): boolean {
  return dateKey >= period.starts_on && dateKey <= period.ends_on
}

// ---------- event filters ----------

export function eventsOn(events: BoardEvent[], dateKey: string, type?: BoardEventType): BoardEvent[] {
  return events.filter(e => e.occurred_on === dateKey && (type === undefined || e.event_type === type))
}

export function eventsInWeekOf(events: BoardEvent[], refKey: string, type?: BoardEventType): BoardEvent[] {
  const monday = mondayOf(refKey)
  const sunday = addDays(monday, 6)
  return events.filter(e =>
    e.occurred_on >= monday && e.occurred_on <= sunday &&
    (type === undefined || e.event_type === type)
  )
}

/** Most recently created event matching the filter — the undo target. */
export function lastEvent(events: BoardEvent[], type: BoardEventType, dateKey?: string): BoardEvent | null {
  const pool = events.filter(e => e.event_type === type && (dateKey === undefined || e.occurred_on === dateKey))
  if (pool.length === 0) return null
  return pool.reduce((a, b) => (b.created_at >= a.created_at ? b : a))
}

// ---------- financial ----------

export interface ContactCounts {
  agent: number
  seller: number
  referral_partner: number
  total: number
}

export function contactCounts(events: BoardEvent[]): ContactCounts {
  const c: ContactCounts = { agent: 0, seller: 0, referral_partner: 0, total: 0 }
  for (const e of events) {
    if (e.event_type !== "contact_touch") continue
    const bucket = e.payload?.bucket
    if (bucket === "agent" || bucket === "seller" || bucket === "referral_partner") {
      c[bucket] += 1
      c.total += 1
    }
  }
  return c
}

// ---------- MTG draft ----------

export interface DraftTotals {
  drafts: number
  wins: number
  losses: number
  /** 0–1, or null when no games have been played. */
  winRate: number | null
}

export function draftTotals(events: BoardEvent[]): DraftTotals {
  let drafts = 0, wins = 0, losses = 0
  for (const e of events) {
    if (e.event_type !== "draft") continue
    drafts += 1
    wins += asCount(e.payload?.wins)
    losses += asCount(e.payload?.losses)
  }
  const games = wins + losses
  return { drafts, wins, losses, winRate: games > 0 ? wins / games : null }
}

// ---------- disc golf ----------

export interface DgStats {
  rounds: number
  /** Mean strokes over par across all rounds, or null with no rounds. */
  avgOverPar: number | null
}

export function dgStats(events: BoardEvent[]): DgStats {
  const scores: number[] = []
  for (const e of events) {
    if (e.event_type !== "dg_round") continue
    const v = e.payload?.over_par
    if (typeof v === "number" && Number.isFinite(v)) scores.push(v)
  }
  return {
    rounds: scores.length,
    avgOverPar: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
  }
}

// ---------- softball ----------

export interface SoftballCounts {
  pa: number
  singles: number
  doubles: number
  triples: number
  hr: number
  bb: number
  sf: number
  k: number
  outs: number
  hits: number
  /** AB = PA − BB − SF (K and non-K outs are at-bats). */
  ab: number
  totalBases: number
}

export function countsFromPa(pa: PaOutcome[]): SoftballCounts {
  const n = (o: PaOutcome) => pa.filter(x => x === o).length
  const singles = n("1B"), doubles = n("2B"), triples = n("3B"), hr = n("HR")
  const bb = n("BB"), sf = n("SF"), k = n("K"), outs = n("OUT")
  const hits = singles + doubles + triples + hr
  return {
    pa: pa.length, singles, doubles, triples, hr, bb, sf, k, outs, hits,
    ab: pa.length - bb - sf,
    totalBases: singles + 2 * doubles + 3 * triples + 4 * hr,
  }
}

export interface RateStats {
  avg: number | null
  obp: number | null
  slg: number | null
  ops: number | null
}

export function rateStats(c: SoftballCounts): RateStats {
  const avg = c.ab > 0 ? c.hits / c.ab : null
  const obpDenom = c.ab + c.bb + c.sf
  const obp = obpDenom > 0 ? (c.hits + c.bb) / obpDenom : null
  const slg = c.ab > 0 ? c.totalBases / c.ab : null
  // A season of nothing but walks has a real OBP but no SLG — treat the
  // missing component as 0 rather than voiding OPS entirely.
  const ops = obp === null && slg === null ? null : (obp ?? 0) + (slg ?? 0)
  return { avg, obp, slg, ops }
}

export function paFromGames(games: BoardEvent[]): PaOutcome[] {
  const all: PaOutcome[] = []
  for (const g of games) {
    if (g.event_type !== "softball_game") continue
    const pa = g.payload?.pa
    if (Array.isArray(pa)) {
      for (const o of pa) if (PA_OUTCOMES.includes(o as PaOutcome)) all.push(o as PaOutcome)
    }
  }
  return all
}

export function seasonStats(games: BoardEvent[]): SoftballCounts & RateStats {
  const counts = countsFromPa(paFromGames(games))
  return { ...counts, ...rateStats(counts) }
}

/** OPS over the most recent n games (by occurred_on, then created_at). null until a game exists. */
export function rollingOps(games: BoardEvent[], n = 5): number | null {
  const sorted = games
    .filter(g => g.event_type === "softball_game")
    .sort((a, b) => (a.occurred_on + a.created_at).localeCompare(b.occurred_on + b.created_at))
  const window = sorted.slice(-n)
  if (window.length === 0) return null
  return rateStats(countsFromPa(paFromGames(window))).ops
}

/** "2-for-3, 1 HR, 1 BB" — the live game line while tapping PAs. */
export function gameLineString(pa: PaOutcome[]): string {
  const c = countsFromPa(pa)
  const parts = [`${c.hits}-for-${Math.max(0, c.ab)}`]
  if (c.hr) parts.push(`${c.hr} HR`)
  if (c.triples) parts.push(`${c.triples} 3B`)
  if (c.doubles) parts.push(`${c.doubles} 2B`)
  if (c.bb) parts.push(`${c.bb} BB`)
  if (c.sf) parts.push(`${c.sf} SF`)
  if (c.k) parts.push(`${c.k} K`)
  return parts.join(", ")
}

// ---------- formatting ----------

/** Baseball-card rate: .333, 1.000, — for null. */
export function formatRate(x: number | null): string {
  if (x === null) return "—"
  const s = x.toFixed(3)
  return x < 1 ? s.replace(/^0/, "") : s
}

export function formatWinRatePct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`
}

/** Golf-style over/under: +3.2, E, -1.5. */
export function formatOverPar(x: number | null, decimals = 1): string {
  if (x === null) return "—"
  const v = Number(x.toFixed(decimals))
  if (v === 0) return "E"
  const s = decimals > 0 ? Math.abs(v).toFixed(decimals) : String(Math.abs(v))
  return v > 0 ? `+${s}` : `-${s}`
}

// ---------- payload validation (shared by API route + tests) ----------

function asCount(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0
}

export type ValidationResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string }

export function validatePayload(eventType: BoardEventType, payload: unknown): ValidationResult {
  const p = (payload ?? {}) as Record<string, unknown>
  switch (eventType) {
    case "contact_touch": {
      const bucket = p.bucket
      if (bucket !== "agent" && bucket !== "seller" && bucket !== "referral_partner") {
        return { ok: false, error: "contact_touch requires bucket: agent | seller | referral_partner" }
      }
      return { ok: true, payload: { bucket } }
    }
    case "draft": {
      const wins = p.wins, losses = p.losses
      if (!isCount(wins) || !isCount(losses)) {
        return { ok: false, error: "draft requires integer wins/losses >= 0" }
      }
      return { ok: true, payload: { wins, losses } }
    }
    case "dg_round": {
      const overPar = p.over_par
      if (typeof overPar !== "number" || !Number.isInteger(overPar) || overPar < -50 || overPar > 100) {
        return { ok: false, error: "dg_round requires integer over_par between -50 and 100" }
      }
      return { ok: true, payload: { over_par: overPar } }
    }
    case "softball_game": {
      const pa = p.pa
      if (!Array.isArray(pa) || pa.length === 0 || pa.length > 30 ||
          !pa.every(o => PA_OUTCOMES.includes(o as PaOutcome))) {
        return { ok: false, error: "softball_game requires pa: 1–30 outcomes from 1B|2B|3B|HR|BB|SF|K|OUT" }
      }
      return { ok: true, payload: { pa } }
    }
    case "offer":
    case "appointment":
    case "dg_practice":
    case "cage":
      return { ok: true, payload: {} }
    default:
      return { ok: false, error: `unknown event_type` }
  }
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100
}

export function isDateKey(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = toUtcNoon(s)
  return !Number.isNaN(d.getTime()) && fromUtcNoon(d) === s
}
