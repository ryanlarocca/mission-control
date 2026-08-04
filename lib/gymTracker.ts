// Gym tracker — pure, framework-agnostic helpers shared by the API routes
// (server) and the GymTracker widget (client). NO Supabase client or env
// access here so it's safe to import from client components. Data access lives
// in lib/physiqSupabase.ts (server-only).

// Ryan's real Physiq auth user id — the single user in the Physiq Supabase
// project (weight_entries / macro_entries are under this id too). Pointing the
// gym data here means the prototype's relative-strength / bodyweight charts use
// his real 267-day bodyweight log, AND the rows are the same ones the future
// physiq-app Workout tab will read under auth.uid(). Replaced with auth.uid()
// once the gym tab ships inside physiq-app.
export const RYAN_USER_ID = "59933c83-cb2e-4e87-87bb-12a1bf1f4ac3"

export type GymCategory = "strength" | "cardio"

export interface GymSet {
  id: string
  exercise_id: string
  date: string // YYYY-MM-DD
  weight_lbs: number
  reps: number
  notes: string | null
  is_pr: boolean
}

export interface GymCardio {
  id: string
  date: string
  exercise_name: string
  duration_minutes: number | null
  speed_mph: number | null
  incline_pct: number | null
  notes: string | null
}

// One card on the Strength tab: an exercise plus its derived stats.
export interface StrengthCard {
  id: string
  name: string
  lastSet: GymSet | null
  prSet: GymSet | null
  sparkline: number[] // e1RM per session, oldest→newest, last 10 sessions
  sessionCount: number
}

// Epley estimated 1-rep-max. Lets us compare sets across weight/rep schemes
// ("225×6 beats 225×5", "335×3 vs 325×6") on a single axis.
export function e1rm(weight: number, reps: number): number {
  return weight * (1 + reps / 30)
}

// "225 × 5" — weight and reps drop trailing .0 but keep Ryan's .25/.75.
export function formatLoad(weight: number, reps: number): string {
  return `${trimNum(weight)} × ${trimNum(reps)}`
}

export function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))
}

// "2026-06-22" → "Jun 22". Parsed as a local date (no TZ shift).
export function formatShortDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

// Build a StrengthCard from an exercise's raw sets. Picks the latest set by
// date (created_at as tiebreak via the array order), the best-e1RM set as the
// PR, and the last-10-sessions e1RM series for the sparkline. `sets` may be in
// any order; we sort defensively.
export function buildStrengthCard(
  exercise: { id: string; name: string },
  sets: GymSet[]
): StrengthCard {
  const sorted = [...sets].sort((a, b) => a.date.localeCompare(b.date))

  const lastSet = sorted.length ? sorted[sorted.length - 1] : null

  let prSet: GymSet | null = null
  let best = -Infinity
  for (const s of sorted) {
    const score = e1rm(s.weight_lbs, s.reps)
    if (score > best) { best = score; prSet = s }
  }

  // One point per session (day): the best e1RM lifted that day. Last 10 days.
  const byDay = new Map<string, number>()
  for (const s of sorted) {
    const score = e1rm(s.weight_lbs, s.reps)
    byDay.set(s.date, Math.max(byDay.get(s.date) ?? 0, score))
  }
  const days = Array.from(byDay.keys()).sort((a, b) => a.localeCompare(b))
  const sparkline = days.slice(-10).map(d => byDay.get(d)!)

  return {
    id: exercise.id,
    name: exercise.name,
    lastSet,
    prSet,
    sparkline,
    sessionCount: byDay.size,
  }
}

// One training day for an exercise, collapsed for the detail chart. topSet is
// the set with the best e1RM that day (what "strongest" means across rep
// schemes); topWeight is the heaviest bar weight regardless of reps — the two
// diverge exactly when you go heavier-for-fewer, which is why the chart shows
// both.
export interface SessionPoint {
  date: string // YYYY-MM-DD
  bestE1rm: number
  topSet: { weight_lbs: number; reps: number }
  topWeight: number
  volume: number // total lbs moved (Σ weight × reps)
  setCount: number
}

export function buildSessionSeries(sets: GymSet[]): SessionPoint[] {
  const byDay = new Map<string, GymSet[]>()
  for (const s of sets) {
    const arr = byDay.get(s.date) ?? []
    arr.push(s)
    byDay.set(s.date, arr)
  }
  return Array.from(byDay.keys())
    .sort((a, b) => a.localeCompare(b))
    .map(date => {
      const day = byDay.get(date)!
      let bestE1rm = -Infinity
      let topSet = day[0]
      let topWeight = 0
      let volume = 0
      for (const s of day) {
        const score = e1rm(s.weight_lbs, s.reps)
        if (score > bestE1rm) { bestE1rm = score; topSet = s }
        topWeight = Math.max(topWeight, s.weight_lbs)
        volume += s.weight_lbs * s.reps
      }
      return {
        date,
        bestE1rm,
        topSet: { weight_lbs: topSet.weight_lbs, reps: topSet.reps },
        topWeight,
        volume,
        setCount: day.length,
      }
    })
}

// Rep-max PRs: the heaviest weight ever lifted at each rep count (fractional
// reps bucket down, so 8.25 counts as an 8RM). Earliest date wins a weight
// tie — that's when the PR was actually set.
export interface RepPR {
  reps: number
  weight_lbs: number
  date: string
  e1: number
}

export function repPRs(sets: GymSet[]): RepPR[] {
  const byReps = new Map<number, GymSet>()
  for (const s of sets) {
    const bucket = Math.floor(s.reps)
    if (bucket < 1) continue
    const cur = byReps.get(bucket)
    if (!cur || s.weight_lbs > cur.weight_lbs || (s.weight_lbs === cur.weight_lbs && s.date < cur.date)) {
      byReps.set(bucket, s)
    }
  }
  return Array.from(byReps.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([reps, s]) => ({
      reps,
      weight_lbs: s.weight_lbs,
      date: s.date,
      e1: e1rm(s.weight_lbs, s.reps),
    }))
}

// ---------------------------------------------------------------------------
// Voice parsing (Part 3). Pure string → {weight, reps, notes}. Used by the
// LogSetSheet mic button after Web Speech transcription.
// ---------------------------------------------------------------------------

export interface ParsedVoiceSet {
  weight?: number
  reps?: number
  notes?: string
  raw: string
}

const ONES: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
}
const FRACTIONS: Record<string, number> = {
  quarter: 0.25, half: 0.5, "three-quarters": 0.75,
}

// Parse a run of spelled-out number words (0–999) into a number, e.g.
// "two twenty five" → 225, "one hundred" → 100, "two hundred twenty five" → 225.
function wordsToNumber(words: string[]): number | null {
  if (!words.length) return null
  let total = 0
  let current = 0
  let matchedAny = false
  for (const w of words) {
    if (w === "hundred") {
      current = (current || 1) * 100
      matchedAny = true
    } else if (w in TENS) {
      current += TENS[w]
      matchedAny = true
    } else if (w in ONES) {
      // "two twenty five": when current already holds 20+, a following
      // single digit (≤9) adds; otherwise treat 2-digit chains like "two
      // twenty" by scaling.
      current += ONES[w]
      matchedAny = true
    } else if (w === "and") {
      continue
    } else {
      return matchedAny ? total + current : null
    }
  }
  return matchedAny ? total + current : null
}

// Special case "two twenty-five" style: a single-digit hundreds word followed
// by a tens+ones group with no "hundred". e.g. ["two","twenty","five"] = 225.
function parseSpokenWeight(words: string[]): number | null {
  const direct = wordsToNumber(words)
  if (words.length >= 2 && words[0] in ONES && ONES[words[0]] <= 9) {
    const rest = words.slice(1)
    const restVal = wordsToNumber(rest)
    if (restVal !== null && restVal < 100 && !words.includes("hundred")) {
      return ONES[words[0]] * 100 + restVal
    }
  }
  return direct
}

export function parseVoiceSet(transcript: string): ParsedVoiceSet {
  const raw = transcript.trim()
  const lower = raw.toLowerCase()
  const result: ParsedVoiceSet = { raw }

  // Connector words between weight and reps: for / by / times / x
  // Numeric form first: "225 for 5", "100 x 8", "45 for 8.25"
  const numMatch = lower.match(
    /(\d+(?:\.\d+)?)\s*(?:for|by|times|x|×|@)\s*(\d+(?:\.\d+)?)/
  )
  if (numMatch) {
    result.weight = parseFloat(numMatch[1])
    result.reps = parseFloat(numMatch[2])
  } else {
    // Spelled-out form: split on the connector word, parse each side.
    const conn = lower.match(/\b(for|by|times)\b/)
    if (conn) {
      const idx = lower.indexOf(conn[0])
      const leftWords = lower.slice(0, idx).split(/[\s-]+/).filter(Boolean)
      const rightRaw = lower.slice(idx + conn[0].length)
      const w = parseSpokenWeight(leftWords)
      if (w !== null) result.weight = w
      const reps = parseSpokenReps(rightRaw)
      if (reps !== null) result.reps = reps
    }
  }

  // Notes: anything after a comma, or trailing "felt …" / "fatigued" phrasing.
  const comma = raw.indexOf(",")
  if (comma >= 0) {
    const after = raw.slice(comma + 1).trim()
    if (after) result.notes = after
  } else {
    const noteMatch = raw.match(/\b(fatigued|felt [a-z]+|heavy|easy|paused?|tough|didn'?t .+)$/i)
    if (noteMatch) result.notes = noteMatch[0]
  }

  return result
}

// Reps side may include fractions: "8 and a quarter", "eight point two five",
// "8.25", "five".
function parseSpokenReps(s: string): number | null {
  const t = s.toLowerCase().replace(/\breps?\b/g, " ").trim()

  // numeric "8.25" or "8"
  const num = t.match(/\d+(?:\.\d+)?/)
  let base: number | null = num ? parseFloat(num[0]) : null

  // "and a quarter" / "and a half"
  for (const [word, val] of Object.entries(FRACTIONS)) {
    if (t.includes(word)) {
      if (base === null) base = 0
      base += val
    }
  }

  if (base !== null) return base

  // fully spelled: "eight point two five"
  const pointIdx = t.indexOf("point")
  if (pointIdx >= 0) {
    const whole = wordsToNumber(t.slice(0, pointIdx).split(/[\s-]+/).filter(Boolean))
    const decimalWords = t.slice(pointIdx + 5).split(/[\s-]+/).filter(Boolean)
    const decimalDigits = decimalWords.map(w => ONES[w]).filter(d => d !== undefined)
    if (whole !== null && decimalDigits.length) {
      return parseFloat(`${whole}.${decimalDigits.join("")}`)
    }
  }

  const spelled = wordsToNumber(t.split(/[\s-]+/).filter(Boolean))
  return spelled
}

// ---------------------------------------------------------------------------
// Voice quick-log: parse exercise + weight + reps from one phrase, e.g.
// "bench press 225 for 5". exerciseText is everything before the first number;
// the rest reuses parseVoiceSet.
// ---------------------------------------------------------------------------

export interface ParsedQuickLog extends ParsedVoiceSet {
  exerciseText: string
}

export function parseVoiceQuickLog(transcript: string): ParsedQuickLog {
  const base = parseVoiceSet(transcript)
  const raw = transcript.trim()
  // Exercise name = words before the first numeric digit (covers the common
  // "bench press 225 for 5" form). Spelled-out weights without a leading
  // exercise name (e.g. "two twenty-five for five") yield an empty name.
  const digitMatch = raw.match(/\d/)
  let exerciseText = ""
  if (digitMatch && digitMatch.index! > 0) {
    exerciseText = raw.slice(0, digitMatch.index).trim().replace(/[,;]+$/, "")
  }
  return { ...base, exerciseText }
}

// Fuzzy-match a spoken exercise name against the user's saved exercises.
// Token-overlap + substring scoring; returns the best candidate above a
// small threshold, else null. "bench" → Bench Press, "incline" → Incline DB
// Press, "squat" → Barbell Squat.
export function matchExercise<T extends { name: string }>(
  spoken: string,
  candidates: T[]
): T | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
  const target = norm(spoken)
  if (!target) return null
  const targetTokens = new Set(target.split(" ").filter(Boolean))

  let best: T | null = null
  let bestScore = 0
  for (const c of candidates) {
    const name = norm(c.name)
    const nameTokens = name.split(" ").filter(Boolean)
    let score = 0
    if (name === target) score = 100
    else if (name.includes(target) || target.includes(name)) score = 50
    // token overlap
    for (const tok of nameTokens) {
      if (targetTokens.has(tok)) score += 10
      else if (tok.length >= 4 && target.includes(tok)) score += 6
    }
    if (score > bestScore) { bestScore = score; best = c }
  }
  return bestScore >= 10 ? best : null
}

// ---------------------------------------------------------------------------
// Bodyweight + relative strength
// ---------------------------------------------------------------------------

export interface WeightPoint {
  date: string // YYYY-MM-DD
  weight: number // lbs
}

// Bodyweight on-or-before `date` (carry-forward), falling back to the earliest
// entry if the lift predates all weigh-ins. `series` must be ascending by date.
export function bodyweightOn(series: WeightPoint[], date: string): number | null {
  if (!series.length) return null
  let result: number | null = null
  for (const p of series) {
    if (p.date <= date) result = p.weight
    else break
  }
  return result ?? series[0].weight
}

export const STRENGTH_TIERS = ["Beginner", "Novice", "Intermediate", "Advanced", "Elite"] as const
export type StrengthTier = (typeof STRENGTH_TIERS)[number]

// 1RM-as-multiple-of-bodyweight thresholds to ENTER each tier (male, approx —
// in the strengthlevel.com / ExRx ballpark). Used for the relative-strength
// "category." Only the big compounds have standards; other lifts are skipped.
const STANDARDS: Record<string, number[]> = {
  //         Beg   Nov   Int   Adv   Elite
  bench:    [0.75, 1.0, 1.25, 1.5, 2.0],
  squat:    [1.0, 1.25, 1.5, 2.0, 2.5],
  deadlift: [1.25, 1.5, 1.75, 2.25, 2.75],
  ohp:      [0.5, 0.65, 0.8, 1.0, 1.25],
}

export type StandardKey = keyof typeof STANDARDS

// Map an exercise name to a standards bucket, or null if it has none.
export function standardKeyFor(name: string): StandardKey | null {
  const n = name.toLowerCase()
  if (n.includes("deadlift")) return "deadlift"
  if (n.includes("squat")) return "squat"
  if (n.includes("bench")) return "bench"
  if (n.includes("shoulder") || n.includes("overhead") || n.includes("ohp")) return "ohp"
  return null
}

export interface RelativeStrength {
  ratio: number
  tier: StrengthTier
  tierIndex: number
  nextTier: StrengthTier | null
  progressToNext: number // 0..1 toward the next tier
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export function relativeStrength(key: StandardKey, e1rmLbs: number, bodyweightLbs: number): RelativeStrength {
  const thresholds = STANDARDS[key]
  const ratio = e1rmLbs / bodyweightLbs
  let achieved = -1
  for (let i = 0; i < thresholds.length; i++) if (ratio >= thresholds[i]) achieved = i
  const tierIndex = Math.max(0, achieved)
  const nextIndex = achieved + 1
  const nextTier = nextIndex <= thresholds.length - 1 ? STRENGTH_TIERS[nextIndex] : null
  const floor = achieved >= 0 ? thresholds[achieved] : 0
  const ceil = nextIndex <= thresholds.length - 1 ? thresholds[nextIndex] : thresholds[thresholds.length - 1]
  const progressToNext = nextTier ? clamp01((ratio - floor) / (ceil - floor)) : 1
  return { ratio, tier: STRENGTH_TIERS[tierIndex], tierIndex, nextTier, progressToNext }
}

// ---------------------------------------------------------------------------
// DOTS — bodyweight-normalized "strength score" from the big-3 total.
// ---------------------------------------------------------------------------

export const LB_PER_KG = 2.2046226218
export const lbsToKg = (lbs: number) => lbs / LB_PER_KG

// DOTS (men). total & bodyweight in kg → single comparable score.
export function dots(totalKg: number, bodyweightKg: number): number {
  const bw = bodyweightKg
  const denom =
    -0.000001093 * bw ** 4 +
    0.0007391293 * bw ** 3 -
    0.1918759221 * bw ** 2 +
    24.0900756 * bw -
    307.75076
  if (denom === 0) return 0
  return (totalKg * 500) / denom
}
