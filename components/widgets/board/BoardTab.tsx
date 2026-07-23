"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import {
  daysRemaining,
  localDateKey,
  type BoardEvent,
  type BoardEventType,
  type BoardPeriod,
} from "@/lib/board"
import { TodayView } from "@/components/widgets/board/TodayView"
import { ScoreboardView } from "@/components/widgets/board/ScoreboardView"

// The Board — 90-day goal & rep tracker. This container owns all data:
// one GET for the active period + its full event log, then every tap is an
// optimistic POST (pending row merged into the display list until the server
// confirms). Undo only ever targets server-confirmed rows, so a rapid
// tap-then-undo can't try to delete an id that doesn't exist yet.

type View = "today" | "scoreboard"

export interface BoardActions {
  log: (type: BoardEventType, payload: Record<string, unknown>) => Promise<BoardEvent | null>
  undo: (event: BoardEvent) => Promise<void>
}

export function BoardTab() {
  const [todayKey, setTodayKey] = useState(() => localDateKey())
  const [period, setPeriod] = useState<BoardPeriod | null>(null)
  const [events, setEvents] = useState<BoardEvent[]>([])
  const [pending, setPending] = useState<BoardEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>("today")
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState("")
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const ping = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(""), 1800)
  }, [])

  const load = useCallback(async (dateKey: string) => {
    try {
      setError(null)
      const res = await fetch(`/api/board?date=${dateKey}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`load ${res.status}`)
      const data = await res.json()
      setPeriod(data.period)
      setEvents(data.events ?? [])
    } catch (err) {
      console.error("board load error:", err)
      setError("Couldn't load The Board. Pull to refresh or retry.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(todayKey)
  }, [load, todayKey])

  // Roll "today" at midnight / when the app is foregrounded again, so a
  // phone left open overnight logs to the right day and the countdown ticks.
  useEffect(() => {
    const sync = () => setTodayKey(prev => {
      const now = localDateKey()
      return now === prev ? prev : now
    })
    const interval = setInterval(sync, 60_000)
    document.addEventListener("visibilitychange", sync)
    window.addEventListener("focus", sync)
    return () => {
      clearInterval(interval)
      document.removeEventListener("visibilitychange", sync)
      window.removeEventListener("focus", sync)
    }
  }, [])

  const log = useCallback<BoardActions["log"]>(async (type, payload) => {
    const tempId = `temp-${crypto.randomUUID()}`
    const temp: BoardEvent = {
      id: tempId,
      period_id: period?.id ?? "",
      event_type: type,
      occurred_on: todayKey,
      payload,
      relationship_id: null,
      created_at: new Date().toISOString(),
    }
    setPending(p => [...p, temp])
    try {
      const res = await fetch("/api/board/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: type, occurred_on: todayKey, payload }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error ?? `POST ${res.status}`)
      setPending(p => p.filter(e => e.id !== tempId))
      setEvents(ev => [...ev, data.event])
      return data.event as BoardEvent
    } catch (err) {
      console.error("board log error:", err)
      setPending(p => p.filter(e => e.id !== tempId))
      ping("Log failed — not saved")
      return null
    }
  }, [period?.id, todayKey, ping])

  const undo = useCallback<BoardActions["undo"]>(async (event) => {
    // Optimistically remove; restore on a real failure (404 = already gone).
    setEvents(ev => ev.filter(e => e.id !== event.id))
    try {
      const res = await fetch("/api/board/events", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: event.id }),
      })
      if (!res.ok && res.status !== 404) throw new Error(`DELETE ${res.status}`)
    } catch (err) {
      console.error("board undo error:", err)
      setEvents(ev => [...ev, event])
      ping("Undo failed")
    }
  }, [ping])

  const withBusy = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    if (busy.has(key)) return
    setBusy(b => new Set(b).add(key))
    try {
      await fn()
    } finally {
      setBusy(b => {
        const next = new Set(b)
        next.delete(key)
        return next
      })
    }
  }, [busy])

  if (loading) {
    return <div className="max-w-3xl py-12 text-center text-sm text-zinc-500">Loading The Board…</div>
  }
  if (error) {
    return (
      <div className="max-w-3xl py-12 text-center">
        <p className="mb-4 text-sm text-red-400">{error}</p>
        <button
          onClick={() => { setLoading(true); load(todayKey) }}
          className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-100 hover:bg-zinc-700"
        >
          Retry
        </button>
      </div>
    )
  }
  if (!period) {
    return (
      <div className="max-w-3xl py-12 text-center text-sm text-zinc-500">
        No goal period configured yet — create one via POST /api/board/periods.
      </div>
    )
  }

  const displayEvents = pending.length ? [...events, ...pending] : events
  const daysLeft = daysRemaining(period, todayKey)
  const actions: BoardActions = { log, undo }

  return (
    <div className="max-w-3xl pb-24 md:pb-6">
      {/* header */}
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">The Board</h1>
          <p className="text-sm text-zinc-500">{period.label}</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-2xl font-semibold leading-none text-amber-400">{daysLeft}</p>
          <p className="text-[11px] text-zinc-500">days left</p>
        </div>
      </div>

      {/* desktop sub-tabs */}
      <div className="mb-4 hidden gap-1.5 border-b border-zinc-800 md:flex">
        {(["today", "scoreboard"] as View[]).map(key => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm capitalize transition-colors",
              view === key
                ? "border-zinc-100 font-medium text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-200"
            )}
          >
            {key}
          </button>
        ))}
      </div>

      {view === "today" ? (
        <TodayView
          events={displayEvents}
          confirmed={events}
          todayKey={todayKey}
          actions={actions}
          busy={busy}
          withBusy={withBusy}
        />
      ) : (
        <ScoreboardView events={displayEvents} period={period} todayKey={todayKey} />
      )}

      {/* toast */}
      {toast && (
        <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full bg-zinc-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-900 md:bottom-8">
          {toast}
        </div>
      )}

      {/* mobile bottom tab bar — one-thumb switching */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex border-t border-zinc-800 bg-zinc-950/95 backdrop-blur md:hidden">
        {(["today", "scoreboard"] as View[]).map(key => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={cn(
              "flex-1 pb-[max(0.9rem,env(safe-area-inset-bottom))] pt-3.5 text-sm font-semibold uppercase tracking-widest transition-colors",
              view === key ? "text-amber-400" : "text-zinc-500"
            )}
          >
            {key}
          </button>
        ))}
      </div>
    </div>
  )
}
