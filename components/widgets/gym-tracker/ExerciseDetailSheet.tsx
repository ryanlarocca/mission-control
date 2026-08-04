"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Plus, X } from "lucide-react"
import {
  buildSessionSeries,
  e1rm,
  formatLoad,
  formatShortDate,
  repPRs,
  trimNum,
  type GymSet,
  type StrengthCard,
} from "@/lib/gymTracker"
import { ExerciseChart } from "./ExerciseChart"
import { VolumeChart } from "./VolumeChart"
import { LogSetSheet, type SaveSetResult } from "./LogSetSheet"

type ChartRange = "3m" | "6m" | "1y" | "all"
const RANGES: { key: ChartRange; label: string }[] = [
  { key: "3m", label: "3M" },
  { key: "6m", label: "6M" },
  { key: "1y", label: "1Y" },
  { key: "all", label: "All" },
]

// Local YYYY-MM-DD n months back (matches LogSetSheet's todayLocal approach).
function monthsAgoLocal(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  const off = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - off).toISOString().slice(0, 10)
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number)
  const [by, bm, bd] = b.split("-").map(Number)
  return Math.round(
    (new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime()) / 86400000
  )
}

// Tap-an-exercise detail view: e1RM/top-weight chart, per-session set
// breakdown, and Log Set one tap away. Stays open after a save (mid-workout
// you want to see the new point land) — parent handles the toast + board
// refresh via onLogged.
export function ExerciseDetailSheet({
  card,
  onClose,
  onLogged,
}: {
  card: StrengthCard
  onClose: () => void
  onLogged: (result: SaveSetResult) => void
}) {
  const [sets, setSets] = useState<GymSet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [range, setRange] = useState<ChartRange>("all")

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/physiq/gym/exercise?id=${card.id}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to load history")
      setSets(json.sets ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load history")
      setSets([])
    }
  }, [card.id])

  useEffect(() => { load() }, [load])

  // Esc closes the detail — unless the log sheet is on top (it owns Esc then).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !showLog) onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, showLog])

  const sessions = useMemo(() => (sets ? buildSessionSeries(sets) : null), [sets])

  // Freshest PR from the loaded history so the nested LogSetSheet header
  // doesn't show a stale card.prSet after a same-visit PR.
  const liveCard: StrengthCard = useMemo(() => {
    if (!sets?.length) return card
    let prSet = sets[0]
    let best = -Infinity
    for (const s of sets) {
      const score = e1rm(s.weight_lbs, s.reps)
      if (score > best) { best = score; prSet = s }
    }
    return { ...card, prSet }
  }, [card, sets])

  const last = sessions?.length ? sessions[sessions.length - 1] : null
  const prev = sessions && sessions.length > 1 ? sessions[sessions.length - 2] : null
  const bestE1 = sessions?.length ? Math.max(...sessions.map(s => s.bestE1rm)) : null
  const delta = last && prev ? last.bestE1rm - prev.bestE1rm : null

  // Charts + trend respect the range filter; PRs, cadence & history stay
  // all-time (a rep max doesn't expire because the pill says 3M).
  const cutoff = range === "all" ? null : monthsAgoLocal(range === "3m" ? 3 : range === "6m" ? 6 : 12)
  const visible = useMemo(
    () => (sessions ?? []).filter(s => !cutoff || s.date >= cutoff),
    [sessions, cutoff]
  )
  const trend =
    visible.length > 1 ? visible[visible.length - 1].bestE1rm - visible[0].bestE1rm : null

  const prTable = useMemo(() => (sets ? repPRs(sets) : []), [sets])
  const bestPrE1 = prTable.length ? Math.max(...prTable.map(p => p.e1)) : null

  const cadence = useMemo(() => {
    if (!sessions || sessions.length < 2) return null
    let sum = 0
    for (let i = 1; i < sessions.length; i++) sum += daysBetween(sessions[i - 1].date, sessions[i].date)
    const lastDate = sessions[sessions.length - 1].date
    const prDate = sessions.reduce((acc, s) => (s.bestE1rm > acc.bestE1rm ? s : acc)).date
    const off = new Date().getTimezoneOffset() * 60000
    const today = new Date(Date.now() - off).toISOString().slice(0, 10)
    return {
      avgGap: sum / (sessions.length - 1),
      sinceLast: daysBetween(lastDate, today),
      sessionsSincePr: sessions.filter(s => s.date > prDate).length,
    }
  }, [sessions])

  // Sessions newest-first for the history list.
  const history = useMemo(() => {
    if (!sets) return []
    const byDay = new Map<string, GymSet[]>()
    for (const s of sets) {
      const arr = byDay.get(s.date) ?? []
      arr.push(s)
      byDay.set(s.date, arr)
    }
    return Array.from(byDay.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  }, [sets])

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
        onClick={onClose}
      >
        <div
          className="w-full sm:max-w-xl bg-zinc-950 border-t sm:border border-zinc-800 sm:rounded-lg rounded-t-2xl flex flex-col max-h-[92vh] sm:max-h-[85vh] animate-in slide-in-from-bottom-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between p-5 pb-3">
            <div>
              <h2 className="text-zinc-100 font-semibold text-lg leading-tight">{card.name}</h2>
              {liveCard.prSet && (
                <p className="text-xs text-amber-400 mt-0.5">
                  🏆 PR {formatLoad(liveCard.prSet.weight_lbs, liveCard.prSet.reps)}
                  <span className="text-zinc-500"> · {formatShortDate(liveCard.prSet.date)}</span>
                </p>
              )}
            </div>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 p-1" aria-label="Close">
              <X size={20} />
            </button>
          </div>

          <div className="overflow-y-auto px-5 pb-5 space-y-4">
            {error && <p className="text-xs text-red-400">{error}</p>}

            {sets === null ? (
              <div className="space-y-3">
                <div className="h-16 bg-zinc-900 rounded-lg animate-pulse" />
                <div className="h-48 bg-zinc-900 rounded-lg animate-pulse" />
              </div>
            ) : (
              <>
                {/* Stat row */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wide">Best e1RM</p>
                    <p className="text-lg font-bold text-zinc-100 leading-tight">
                      {bestE1 != null ? Math.round(bestE1) : "—"}
                    </p>
                  </div>
                  <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wide">Last session</p>
                    <p className="text-lg font-bold text-zinc-100 leading-tight">
                      {last ? Math.round(last.bestE1rm) : "—"}
                    </p>
                    {delta != null && (
                      <p
                        className={`text-[11px] font-medium ${
                          delta > 0 ? "text-emerald-400" : delta < 0 ? "text-red-400" : "text-zinc-500"
                        }`}
                      >
                        {delta > 0 ? "▲ +" : delta < 0 ? "▼ " : ""}
                        {Math.round(Math.abs(delta) * 10) / 10 === 0 ? "even" : `${Math.round(delta * 10) / 10} vs prior`}
                      </p>
                    )}
                  </div>
                  <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wide">Sessions</p>
                    <p className="text-lg font-bold text-zinc-100 leading-tight">{sessions?.length ?? 0}</p>
                  </div>
                </div>

                {/* Cadence strip */}
                {cadence && (
                  <p className="text-[11px] text-zinc-500 px-0.5">
                    Trained every ~{Math.round(cadence.avgGap)} days ·{" "}
                    {cadence.sinceLast === 0
                      ? "last trained today"
                      : `last trained ${cadence.sinceLast} ${cadence.sinceLast === 1 ? "day" : "days"} ago`}
                    {cadence.sessionsSincePr > 0 &&
                      ` · ${cadence.sessionsSincePr} ${cadence.sessionsSincePr === 1 ? "session" : "sessions"} since PR`}
                  </p>
                )}

                {/* Range filter — applies to both charts + the trend chip */}
                <div className="flex gap-1.5">
                  {RANGES.map(r => (
                    <button
                      key={r.key}
                      onClick={() => setRange(r.key)}
                      className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                        range === r.key
                          ? "bg-zinc-700 text-zinc-100"
                          : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>

                {/* Progression chart */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                  <div className="flex items-baseline justify-between mb-2">
                    <p className="text-xs text-zinc-500 uppercase tracking-wide">Progression</p>
                    {trend != null && (
                      <span
                        className={`text-[11px] font-medium ${
                          trend > 0 ? "text-emerald-400" : trend < 0 ? "text-red-400" : "text-zinc-500"
                        }`}
                      >
                        {trend > 0 ? "▲ +" : trend < 0 ? "▼ −" : ""}
                        {Math.round(Math.abs(trend))} e1RM{" "}
                        {range === "all" ? "all time" : `in ${RANGES.find(r => r.key === range)!.label.toLowerCase()}`}
                      </span>
                    )}
                  </div>
                  <ExerciseChart points={visible} />
                  <p className="text-[11px] text-zinc-600 mt-2">
                    Est. 1RM (Epley) puts every rep scheme on one strength axis — heavier
                    for fewer reps still moves it up. Tap or drag the chart to inspect a session.
                  </p>
                </div>

                {/* Volume per session */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                  <p className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Volume per session</p>
                  <VolumeChart points={visible} />
                  <p className="text-[11px] text-zinc-600 mt-2">
                    Total lbs moved (weight × reps, all sets). Intensity up + volume down is a
                    normal peaking trade — both sliding is the flag.
                  </p>
                </div>

                {/* Rep-max PRs */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                  <p className="text-xs text-zinc-500 uppercase tracking-wide mb-3">Rep maxes (all time)</p>
                  {prTable.length === 0 ? (
                    <p className="text-sm text-zinc-500">No sets logged yet.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {prTable.map(p => (
                        <div key={p.reps} className="flex items-baseline justify-between text-sm">
                          <span className="text-zinc-400 w-16 shrink-0">
                            {p.reps} {p.reps === 1 ? "rep" : "reps"}
                          </span>
                          <span className="text-zinc-200 font-medium">
                            {trimNum(p.weight_lbs)} lb
                            {p.e1 === bestPrE1 && <span className="text-amber-400 text-xs"> 🏆</span>}
                          </span>
                          <span className="text-zinc-600 text-xs text-right w-28 shrink-0">
                            e1RM {Math.round(p.e1)} · {formatShortDate(p.date)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Session history */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                  <p className="text-xs text-zinc-500 uppercase tracking-wide mb-3">History</p>
                  {history.length === 0 ? (
                    <p className="text-sm text-zinc-500">No sets logged yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {history.map(([date, daySets]) => {
                        const volume = daySets.reduce((s, x) => s + x.weight_lbs * x.reps, 0)
                        return (
                          <div key={date}>
                            <div className="flex items-baseline justify-between mb-1">
                              <span className="text-sm font-medium text-zinc-200">{formatShortDate(date)}</span>
                              <span className="text-[11px] text-zinc-600">
                                {daySets.length} {daySets.length === 1 ? "set" : "sets"} ·{" "}
                                {Math.round(volume).toLocaleString()} lb
                              </span>
                            </div>
                            <div className="space-y-1">
                              {daySets.map(s => (
                                <div key={s.id} className="flex items-baseline justify-between text-sm">
                                  <span className="text-zinc-300">
                                    {formatLoad(s.weight_lbs, s.reps)}
                                    {s.is_pr && <span className="text-amber-400 text-xs"> 🏆</span>}
                                    {s.notes && <span className="text-zinc-500 text-xs"> · {s.notes}</span>}
                                  </span>
                                  <span className="text-zinc-500 text-xs">
                                    e1RM {Math.round(e1rm(s.weight_lbs, s.reps))}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="p-4 pt-3 border-t border-zinc-800">
            <button
              onClick={() => setShowLog(true)}
              className="w-full flex items-center justify-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-zinc-950 rounded-lg py-3 text-sm font-semibold"
            >
              <Plus size={16} /> Log Set
            </button>
          </div>
        </div>
      </div>

      {showLog && (
        <LogSetSheet
          card={liveCard}
          onClose={() => setShowLog(false)}
          onSaved={(r) => {
            setShowLog(false)
            onLogged(r)
            load()
          }}
        />
      )}
    </>
  )
}
