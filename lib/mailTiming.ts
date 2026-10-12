// Pure helpers for the direct-mail response-timing report
// (GET /api/campaigns/[id]/timing → mail_response_timing() SQL function).
// Kept free of React / Supabase so they unit-test cleanly.

export interface TimingBatch {
  batch: number | null
  pieces: number
  responders: number
  median_days: number | null
  p25_days: number | null
  p75_days: number | null
  // Responders by whole weeks since arrival: {"0": n, "1": n, …}. 0 = the
  // first 7 days. A negative key means the lead was logged before the
  // record's arrival date. Empty when no linked record has an arrival date.
  weekly: Record<string, number>
}

export interface WeekBucket { week: number; n: number }

// Expand the sparse {"0": 3, "2": 1} object into a dense, ordered series
// with the gaps filled by zeros, so bars line up week-for-week across
// batches. Runs from min(0, lowest key) through the highest key; an empty
// object yields an empty series. Non-integer keys are ignored.
export function weeklySeries(weekly: Record<string, number> | null | undefined): WeekBucket[] {
  const counts = new Map<number, number>()
  for (const [k, v] of Object.entries(weekly ?? {})) {
    if (!/^-?\d+$/.test(k)) continue
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    counts.set(Number(k), (counts.get(Number(k)) ?? 0) + n)
  }
  if (counts.size === 0) return []
  const keys = Array.from(counts.keys())
  const lo = Math.min(0, ...keys)
  const hi = Math.max(...keys)
  const out: WeekBucket[] = []
  for (let w = lo; w <= hi; w++) out.push({ week: w, n: counts.get(w) ?? 0 })
  return out
}

// Compact text rendering of the weekly histogram: "w0 3 · w1 5 · w2 1".
// Weeks with no responders are kept so the gaps read as gaps. Empty input
// renders as "—".
export function weeklyText(weekly: Record<string, number> | null | undefined): string {
  const series = weeklySeries(weekly)
  if (series.length === 0) return "—"
  return series.map(b => `w${b.week} ${b.n}`).join(" · ")
}

// Day values as the table shows them: one decimal only when needed, "—"
// for a batch with no arrival date yet (the state until arrived_at /
// drop_date are stamped).
export function fmtDays(n: number | string | null | undefined): string {
  if (n == null) return "—"
  const v = Number(n)
  if (!Number.isFinite(v)) return "—"
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

// Batch label: null batch (records imported without one) reads as "—".
export function fmtBatch(batch: number | null | undefined): string {
  return batch == null ? "—" : String(batch)
}
