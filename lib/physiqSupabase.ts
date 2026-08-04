// Server-side Supabase client for the Physiq project (gym tracker). This is a
// SEPARATE Supabase project from the LRG Homes CRMS one (lib/leads.ts) — keep
// the two clients from getting crossed. Uses the service_role key, so it
// bypasses RLS; all gym-tracker data flows through the /api/physiq/gym/* routes
// rather than the browser hitting Supabase directly (mirrors getLeadsClient).

import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import {
  RYAN_USER_ID,
  buildStrengthCard,
  bodyweightOn,
  dots,
  e1rm,
  lbsToKg,
  relativeStrength,
  standardKeyFor,
  STRENGTH_TIERS,
  type GymSet,
  type GymCardio,
  type StrengthCard,
  type StandardKey,
  type StrengthTier,
  type RelativeStrength,
  type WeightPoint,
} from "@/lib/gymTracker"

let cached: SupabaseClient | null = null

export function getPhysiqClient(): SupabaseClient {
  if (cached) return cached
  const url = process.env.NEXT_PUBLIC_PHYSIQ_SUPABASE_URL
  const key = process.env.PHYSIQ_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_PHYSIQ_SUPABASE_URL and PHYSIQ_SUPABASE_SERVICE_ROLE_KEY must be set"
    )
  }
  // cache:no-store for the same reason as getLeadsClient — Next caches GET
  // fetch()es at the URL level, which would serve stale gym data after a log.
  cached = createClient(url, key, {
    auth: { persistSession: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...(init ?? {}), cache: "no-store" }),
    },
  })
  return cached
}

// ---------------------------------------------------------------------------
// Strength
// ---------------------------------------------------------------------------

// All strength exercises + derived card stats, sorted most-recently-trained
// first. One round-trip for exercises, one for sets.
export async function getStrengthBoard(userId = RYAN_USER_ID): Promise<StrengthCard[]> {
  const db = getPhysiqClient()

  const { data: exercises, error: exErr } = await db
    .from("gym_exercises")
    .select("id, name")
    .eq("user_id", userId)
    .eq("category", "strength")
  if (exErr) throw new Error(exErr.message)
  if (!exercises?.length) return []

  const { data: sets, error: setErr } = await db
    .from("gym_sets")
    .select("id, exercise_id, date, weight_lbs, reps, notes, is_pr")
    .eq("user_id", userId)
    .order("date", { ascending: true })
  if (setErr) throw new Error(setErr.message)

  const byExercise = new Map<string, GymSet[]>()
  for (const s of (sets ?? []) as GymSet[]) {
    const arr = byExercise.get(s.exercise_id) ?? []
    arr.push(s)
    byExercise.set(s.exercise_id, arr)
  }

  const cards = exercises.map(ex => buildStrengthCard(ex, byExercise.get(ex.id) ?? []))

  // Most-recently-trained first; exercises with no sets sink to the bottom.
  cards.sort((a, b) => {
    const ad = a.lastSet?.date ?? ""
    const bd = b.lastSet?.date ?? ""
    return bd.localeCompare(ad)
  })
  return cards
}

// Full set history for one exercise — powers the exercise detail sheet
// (chart + per-session breakdown). date asc, created_at asc as the same-day
// tiebreak so sets list in the order they were logged.
export async function getExerciseHistory(
  exerciseId: string,
  userId = RYAN_USER_ID
): Promise<{ exercise: { id: string; name: string }; sets: GymSet[] }> {
  const db = getPhysiqClient()
  const [exRes, setRes] = await Promise.all([
    db
      .from("gym_exercises")
      .select("id, name")
      .eq("id", exerciseId)
      .eq("user_id", userId)
      .single(),
    db
      .from("gym_sets")
      .select("id, exercise_id, date, weight_lbs, reps, notes, is_pr")
      .eq("user_id", userId)
      .eq("exercise_id", exerciseId)
      .order("date", { ascending: true })
      .order("created_at", { ascending: true }),
  ])
  if (exRes.error) throw new Error(exRes.error.message)
  if (setRes.error) throw new Error(setRes.error.message)
  return {
    exercise: exRes.data as { id: string; name: string },
    sets: (setRes.data ?? []) as GymSet[],
  }
}

// Insert a strength set and recompute is_pr against the exercise's prior best
// e1RM. Returns the inserted set + whether it set a new PR.
export async function insertStrengthSet(input: {
  exerciseId: string
  date: string
  weight_lbs: number
  reps: number
  notes?: string | null
  userId?: string
}): Promise<{ set: GymSet; isNewPr: boolean }> {
  const db = getPhysiqClient()
  const userId = input.userId ?? RYAN_USER_ID

  const { data: prior, error: priorErr } = await db
    .from("gym_sets")
    .select("weight_lbs, reps")
    .eq("user_id", userId)
    .eq("exercise_id", input.exerciseId)
  if (priorErr) throw new Error(priorErr.message)

  let bestPrior = -Infinity
  for (const s of prior ?? []) {
    bestPrior = Math.max(bestPrior, e1rm(Number(s.weight_lbs), Number(s.reps)))
  }
  const score = e1rm(input.weight_lbs, input.reps)
  const isNewPr = score > bestPrior

  const { data, error } = await db
    .from("gym_sets")
    .insert({
      user_id: userId,
      exercise_id: input.exerciseId,
      date: input.date,
      weight_lbs: input.weight_lbs,
      reps: input.reps,
      notes: input.notes || null,
      is_pr: isNewPr,
    })
    .select("id, exercise_id, date, weight_lbs, reps, notes, is_pr")
    .single()
  if (error) throw new Error(error.message)

  return { set: data as GymSet, isNewPr }
}

export async function addExercise(input: {
  name: string
  category: "strength" | "cardio"
  userId?: string
}): Promise<{ id: string }> {
  const db = getPhysiqClient()
  const { data, error } = await db
    .from("gym_exercises")
    .insert({
      user_id: input.userId ?? RYAN_USER_ID,
      name: input.name.trim(),
      category: input.category,
    })
    .select("id")
    .single()
  if (error) throw new Error(error.message)
  return { id: data.id as string }
}

// ---------------------------------------------------------------------------
// Cardio
// ---------------------------------------------------------------------------

export async function getCardio(userId = RYAN_USER_ID): Promise<GymCardio[]> {
  const db = getPhysiqClient()
  const { data, error } = await db
    .from("gym_cardio")
    .select("id, date, exercise_name, duration_minutes, speed_mph, incline_pct, notes")
    .eq("user_id", userId)
    .order("date", { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as GymCardio[]
}

// ---------------------------------------------------------------------------
// Stats — relative strength, DOTS, and the strength-vs-bodyweight trend.
// Joins gym_sets with the Physiq project's existing weight_entries log.
// ---------------------------------------------------------------------------

export interface LiftTier {
  name: string
  key: StandardKey
  e1rm: number
  bestSet: { weight_lbs: number; reps: number; date: string } | null
  rel: RelativeStrength
}

export interface StatsSeriesPoint {
  date: string
  dots: number
  totalE1rm: number
  bodyweight: number
}

export interface StatsResult {
  bodyweight: number | null
  bodyweightSeries: WeightPoint[]
  liftTiers: LiftTier[]
  overallTier: { tier: StrengthTier; tierIndex: number } | null
  dotsCurrent: number | null
  series: StatsSeriesPoint[]
}

export async function getStats(userId = RYAN_USER_ID): Promise<StatsResult> {
  const db = getPhysiqClient()

  const [{ data: exercises, error: exErr }, { data: sets, error: setErr }, { data: weights, error: wErr }] =
    await Promise.all([
      db.from("gym_exercises").select("id, name").eq("user_id", userId).eq("category", "strength"),
      db.from("gym_sets").select("exercise_id, date, weight_lbs, reps").eq("user_id", userId),
      db.from("weight_entries").select("date, weight").eq("user_id", userId).order("date", { ascending: true }),
    ])
  if (exErr) throw new Error(exErr.message)
  if (setErr) throw new Error(setErr.message)
  if (wErr) throw new Error(wErr.message)

  // Dedup + sort the bodyweight log (it carries occasional duplicate dates).
  const bwByDate = new Map<string, number>()
  for (const w of weights ?? []) bwByDate.set(w.date, Number(w.weight))
  const bodyweightSeries: WeightPoint[] = Array.from(bwByDate.entries())
    .map(([date, weight]) => ({ date, weight }))
    .sort((a, b) => a.date.localeCompare(b.date))
  const bodyweight = bodyweightSeries.length ? bodyweightSeries[bodyweightSeries.length - 1].weight : null

  const exById = new Map((exercises ?? []).map(e => [e.id, e.name]))
  type Row = { date: string; weight_lbs: number; reps: number }
  const setsByExercise = new Map<string, Row[]>()
  for (const s of sets ?? []) {
    const arr = setsByExercise.get(s.exercise_id) ?? []
    arr.push({ date: s.date, weight_lbs: Number(s.weight_lbs), reps: Number(s.reps) })
    setsByExercise.set(s.exercise_id, arr)
  }

  // Per-lift all-time best e1RM + relative-strength tier (vs current bodyweight).
  const liftTiers: LiftTier[] = []
  for (const [exId, name] of Array.from(exById)) {
    const key = standardKeyFor(name)
    if (!key) continue
    const rows = setsByExercise.get(exId) ?? []
    if (!rows.length || !bodyweight) continue
    let best = -Infinity
    let bestSet: Row | null = null
    for (const r of rows) {
      const score = e1rm(r.weight_lbs, r.reps)
      if (score > best) { best = score; bestSet = r }
    }
    liftTiers.push({
      name,
      key,
      e1rm: best,
      bestSet: bestSet ? { weight_lbs: bestSet.weight_lbs, reps: bestSet.reps, date: bestSet.date } : null,
      rel: relativeStrength(key, best, bodyweight),
    })
  }
  // Order: deadlift, squat, bench, ohp, then anything else by ratio.
  const order: Record<string, number> = { squat: 0, bench: 1, deadlift: 2, ohp: 3 }
  liftTiers.sort((a, b) => (order[a.key] ?? 9) - (order[b.key] ?? 9))

  // Overall tier = mean of the powerlifting big-3 tier indices.
  const big3 = liftTiers.filter(l => l.key === "squat" || l.key === "bench" || l.key === "deadlift")
  let overallTier: StatsResult["overallTier"] = null
  if (big3.length) {
    const idx = Math.round(big3.reduce((s, l) => s + l.rel.tierIndex, 0) / big3.length)
    overallTier = { tier: STRENGTH_TIERS[idx], tierIndex: idx }
  }

  // DOTS trend + strength-vs-bodyweight series. Walk big-3 lift dates ascending,
  // maintaining running-best e1RM per lift; emit a point once all three have a
  // best and a bodyweight is known for that date.
  const big3Keys: StandardKey[] = ["squat", "bench", "deadlift"]
  const exKeyById = new Map<string, StandardKey>()
  for (const [exId, name] of Array.from(exById)) {
    const k = standardKeyFor(name)
    if (k && big3Keys.includes(k)) exKeyById.set(exId, k)
  }
  const dated: { date: string; key: StandardKey; e1rm: number }[] = []
  for (const [exId, key] of Array.from(exKeyById)) {
    for (const r of setsByExercise.get(exId) ?? []) {
      dated.push({ date: r.date, key, e1rm: e1rm(r.weight_lbs, r.reps) })
    }
  }
  dated.sort((a, b) => a.date.localeCompare(b.date))

  const series: StatsSeriesPoint[] = []
  const bestByKey: Record<string, number> = {}
  let lastDate = ""
  for (let i = 0; i < dated.length; i++) {
    const d = dated[i]
    bestByKey[d.key] = Math.max(bestByKey[d.key] ?? 0, d.e1rm)
    // Only emit once per date, after processing all that date's lifts.
    const next = dated[i + 1]
    if (next && next.date === d.date) continue
    if (d.date === lastDate) continue
    const haveAll = big3Keys.every(k => bestByKey[k] > 0)
    if (!haveAll) continue
    const bw = bodyweightOn(bodyweightSeries, d.date)
    if (bw == null) continue
    const totalE1rm = big3Keys.reduce((s, k) => s + bestByKey[k], 0)
    series.push({
      date: d.date,
      totalE1rm,
      bodyweight: bw,
      dots: dots(lbsToKg(totalE1rm), lbsToKg(bw)),
    })
    lastDate = d.date
  }

  const dotsCurrent = series.length ? series[series.length - 1].dots : null

  return { bodyweight, bodyweightSeries, liftTiers, overallTier, dotsCurrent, series }
}

export async function insertCardio(input: {
  date: string
  exercise_name: string
  duration_minutes?: number | null
  speed_mph?: number | null
  incline_pct?: number | null
  notes?: string | null
  userId?: string
}): Promise<GymCardio> {
  const db = getPhysiqClient()
  const { data, error } = await db
    .from("gym_cardio")
    .insert({
      user_id: input.userId ?? RYAN_USER_ID,
      date: input.date,
      exercise_name: input.exercise_name.trim(),
      duration_minutes: input.duration_minutes ?? null,
      speed_mph: input.speed_mph ?? null,
      incline_pct: input.incline_pct ?? null,
      notes: input.notes || null,
    })
    .select("id, date, exercise_name, duration_minutes, speed_mph, incline_pct, notes")
    .single()
  if (error) throw new Error(error.message)
  return data as GymCardio
}
