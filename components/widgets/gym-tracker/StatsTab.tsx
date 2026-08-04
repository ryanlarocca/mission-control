"use client"

import { useEffect, useState } from "react"
import { formatLoad, formatShortDate, STRENGTH_TIERS, type StrengthTier } from "@/lib/gymTracker"
import { LineChart } from "./LineChart"

interface RelativeStrength {
  ratio: number
  tier: StrengthTier
  tierIndex: number
  nextTier: StrengthTier | null
  progressToNext: number
}
interface LiftTier {
  name: string
  key: string
  e1rm: number
  bestSet: { weight_lbs: number; reps: number; date: string } | null
  rel: RelativeStrength
}
interface SeriesPoint { date: string; dots: number; totalE1rm: number; bodyweight: number }
interface Stats {
  bodyweight: number | null
  liftTiers: LiftTier[]
  overallTier: { tier: StrengthTier; tierIndex: number } | null
  dotsCurrent: number | null
  series: SeriesPoint[]
  error?: string
}

// Tier → accent color. Climbs cool→warm so "better" reads brighter.
const TIER_COLOR: Record<StrengthTier, string> = {
  Beginner: "text-zinc-400 bg-zinc-400/10 border-zinc-400/20",
  Novice: "text-sky-400 bg-sky-400/10 border-sky-400/20",
  Intermediate: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
  Advanced: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  Elite: "text-fuchsia-400 bg-fuchsia-400/10 border-fuchsia-400/20",
}
const TIER_FILL: Record<StrengthTier, string> = {
  Beginner: "bg-zinc-400",
  Novice: "bg-sky-400",
  Intermediate: "bg-emerald-400",
  Advanced: "bg-amber-400",
  Elite: "bg-fuchsia-400",
}

export function StatsTab() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/physiq/gym/stats")
      .then(r => r.json())
      .then(j => { if (j.error) setErr(j.error); else setStats(j) })
      .catch(e => setErr(e instanceof Error ? e.message : "Failed to load stats"))
  }, [])

  if (err) return <p className="text-sm text-red-400 py-6">{err}</p>
  if (!stats) {
    return (
      <div className="space-y-3">
        <div className="h-24 bg-zinc-800 rounded-lg animate-pulse" />
        <div className="h-40 bg-zinc-800 rounded-lg animate-pulse" />
      </div>
    )
  }

  const { overallTier, dotsCurrent, bodyweight, liftTiers, series } = stats
  const labels = series.map(p => formatShortDate(p.date))

  return (
    <div className="space-y-4">
      {/* Hero: DOTS + overall tier + bodyweight */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-wide">Strength Score (DOTS)</p>
          <p className="text-3xl font-bold text-zinc-100 leading-tight">
            {dotsCurrent != null ? Math.round(dotsCurrent) : "—"}
          </p>
          {bodyweight != null && (
            <p className="text-xs text-zinc-500 mt-0.5">at {Math.round(bodyweight)} lb bodyweight</p>
          )}
        </div>
        {overallTier && (
          <div className="text-right">
            <p className="text-xs text-zinc-500 mb-1">Overall</p>
            <span className={`text-sm font-semibold rounded-full border px-3 py-1 ${TIER_COLOR[overallTier.tier]}`}>
              {overallTier.tier}
            </span>
          </div>
        )}
      </div>

      {/* Relative strength tiers */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <p className="text-xs text-zinc-500 uppercase tracking-wide mb-3">Relative Strength (× bodyweight)</p>
        <div className="space-y-3">
          {liftTiers.length === 0 && (
            <p className="text-sm text-zinc-500">Log a squat, bench, or deadlift to see your strength tier.</p>
          )}
          {liftTiers.map(lift => (
            <div key={lift.name}>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-sm text-zinc-200">{lift.name}</span>
                <span className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-zinc-100">{lift.rel.ratio.toFixed(2)}×</span>
                  <span className={`text-[11px] font-medium rounded-full border px-2 py-0.5 ${TIER_COLOR[lift.rel.tier]}`}>
                    {lift.rel.tier}
                  </span>
                </span>
              </div>
              {/* progress within the tier ladder */}
              <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${TIER_FILL[lift.rel.tier]}`}
                  style={{
                    width: `${((lift.rel.tierIndex + lift.rel.progressToNext) / (STRENGTH_TIERS.length - 1)) * 100}%`,
                  }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
                <span>
                  {lift.bestSet ? `best ${formatLoad(lift.bestSet.weight_lbs, lift.bestSet.reps)} · e1RM ${Math.round(lift.e1rm)}` : ""}
                </span>
                {lift.rel.nextTier && (
                  <span>{Math.round(lift.rel.progressToNext * 100)}% to {lift.rel.nextTier}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Strength vs bodyweight overlay */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <p className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Strength vs Bodyweight</p>
        {series.length >= 2 ? (
          <>
            <LineChart
              labels={labels}
              left={{ values: series.map(p => p.bodyweight), color: "#60a5fa", label: "Bodyweight (lb)", format: v => `${Math.round(v)}` }}
              right={{ values: series.map(p => p.dots), color: "#f59e0b", label: "DOTS", format: v => `${Math.round(v)}` }}
            />
            <p className="text-[11px] text-zinc-600 mt-2">
              Strength (amber) holding or rising while bodyweight (blue) drops = you&apos;re recomping.
            </p>
          </>
        ) : (
          <p className="text-sm text-zinc-500">Need squat, bench &amp; deadlift history to chart this.</p>
        )}
      </div>
    </div>
  )
}
