"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { Loader2, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { handleSessionExpired } from "@/lib/session-expired"
import { BOARD_LANES, BOARD_LANE_LABEL, pacificToday, sortOpen, type BoardItem, type BoardLane } from "@/lib/boardItems"
import { BoardCard, type CardPhase } from "./BoardCard"
import { BoardSheet, type BoardEdit } from "./BoardSheet"
import { BOARD_CSS, LANE_DOT, clockTime, headerDate, sortDone } from "./boardUi"

// The Board (2026-11-20): one card per open thread, four lanes. Approved
// mockup: /tmp/fri1120/board/mock.html. Tap the circle → it fills → the card
// fades and collapses (cards below slide up) → it lands in Done this week,
// with a 5 s Undo pill. Data: GET/POST/PATCH /api/board.

// v2 (11-24): sorted by next check-in, folded "On hold" group, stale mark,
// history in the card sheet.
const VERSION = "Board v2"
const CHECK_HOLD_MS = 450 // circle filled, card dimmed, before it leaves
const COLLAPSE_MS = 320 // fade + height collapse (matches .board-collapse)
const TOAST_MS = 5000
const FRESH_MS = 700

type Toast =
  | { kind: "undo"; id: string; title: string }
  | { kind: "error"; message: string }

class ApiError extends Error {}

/** fetch → parsed body, or null when the session lapsed (redirect scheduled). */
async function api<T>(method: "GET" | "POST" | "PATCH", body?: unknown): Promise<T | null> {
  const res = await fetch("/api/board", {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (handleSessionExpired(res)) return null
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`)
  if (data === null) throw new ApiError(`HTTP ${res.status}: not JSON`)
  return data as T
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function BoardView() {
  const [items, setItems] = useState<BoardItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const [today, setToday] = useState<string>(() => pacificToday())
  const [anim, setAnim] = useState<Record<string, CardPhase>>({})
  const [fresh, setFresh] = useState<Record<string, true>>({})
  const [toast, setToast] = useState<Toast | null>(null)
  const [editing, setEditing] = useState<BoardItem | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [showHold, setShowHold] = useState(false)
  const [draft, setDraft] = useState("")
  const [adding, setAdding] = useState(false)
  // Cards added this visit sit at the top of their lane (newest first) until
  // the next reload re-sorts them with sortOpen().
  const [pinned, setPinned] = useState<string[]>([])

  const addRef = useRef<HTMLInputElement>(null)
  const animRef = useRef(anim)
  animRef.current = anim
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chains = useRef(new Map<string, Promise<unknown>>()) // per-card PATCH queue
  const seq = useRef(new Map<string, number>()) // latest mutation per card
  const inflight = useRef(0)
  const dirtyAt = useRef(0)
  const reduceMotion = useRef(false)

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    reduceMotion.current = mq.matches
    const on = () => { reduceMotion.current = mq.matches }
    mq.addEventListener?.("change", on)
    return () => mq.removeEventListener?.("change", on)
  }, [])

  // ---- load ---------------------------------------------------------------

  const load = useCallback(async () => {
    const started = Date.now()
    try {
      const data = await api<{ items: BoardItem[] }>("GET")
      if (!data) return
      // A mutation started or finished while this was in flight: its local
      // state is newer than this snapshot, so drop it (the next focus reloads).
      if (inflight.current > 0 || dirtyAt.current >= started) return
      setItems(Array.isArray(data.items) ? data.items : [])
      setPinned([])
      setLoadError(null)
      setLoadedAt(new Date())
      setToday(pacificToday())
    } catch (e) {
      setLoadError(errText(e))
      setLastError(`GET /api/board: ${errText(e)}`)
    }
  }, [])

  useEffect(() => {
    void load()
    let last = Date.now()
    const refresh = () => {
      if (document.visibilityState !== "visible") return
      if (Date.now() - last < 2000) return
      last = Date.now()
      void load()
    }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [load])

  useEffect(() => {
    const t = timers.current
    return () => {
      t.forEach(clearTimeout)
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  // ---- small state helpers ------------------------------------------------

  const replace = useCallback((id: string, fn: (i: BoardItem) => BoardItem) => {
    setItems(prev => prev?.map(i => (i.id === id ? fn(i) : i)) ?? prev)
  }, [])

  const markFresh = useCallback((id: string) => {
    setFresh(f => ({ ...f, [id]: true }))
    setTimeout(() => setFresh(f => {
      const { [id]: _drop, ...rest } = f
      return rest
    }), FRESH_MS)
  }, [])

  const showToast = useCallback((t: Toast) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(t)
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  const showError = useCallback((message: string, technical: string) => {
    setLastError(technical)
    showToast({ kind: "error", message })
  }, [showToast])

  const clearAnim = useCallback((id: string) => {
    const t = timers.current.get(id)
    if (t) clearTimeout(t)
    timers.current.delete(id)
    setAnim(a => {
      if (!(id in a)) return a
      const { [id]: _drop, ...rest } = a
      return rest
    })
  }, [])

  /** Queue a PATCH behind any earlier one for the same card. Resolves to the server copy, or null if this is no longer the latest change. */
  const patch = useCallback((id: string, fields: Record<string, unknown>) => {
    const n = (seq.current.get(id) ?? 0) + 1
    seq.current.set(id, n)
    inflight.current += 1
    dirtyAt.current = Date.now()
    const prev = chains.current.get(id) ?? Promise.resolve()
    const run = prev.then(() => api<{ item: BoardItem }>("PATCH", { id, ...fields }))
    chains.current.set(id, run.catch(() => undefined))
    return run
      .then(data => (seq.current.get(id) === n ? data?.item ?? null : null))
      .catch(e => {
        // Only the latest change may roll the card back.
        if (seq.current.get(id) !== n) return null
        throw e
      })
      .finally(() => {
        inflight.current -= 1
        dirtyAt.current = Date.now()
      })
  }, [])

  // ---- actions ------------------------------------------------------------

  /** Open card → done, Reminders style. */
  const complete = useCallback((item: BoardItem) => {
    if (animRef.current[item.id]) return
    const id = item.id
    const snapshot = item
    const quick = reduceMotion.current

    const finish = () => {
      timers.current.delete(id)
      replace(id, i => (i.status === "done" ? i : { ...i, status: "done", done_at: i.done_at ?? new Date().toISOString() }))
      setAnim(a => {
        const { [id]: _drop, ...rest } = a
        return rest
      })
      markFresh(id)
    }

    if (quick) {
      finish()
    } else {
      setAnim(a => ({ ...a, [id]: "checked" }))
      timers.current.set(id, setTimeout(() => {
        setAnim(a => (a[id] ? { ...a, [id]: "collapsing" } : a))
        timers.current.set(id, setTimeout(finish, COLLAPSE_MS))
      }, CHECK_HOLD_MS))
    }
    showToast({ kind: "undo", id, title: item.title })

    patch(id, { status: "done" })
      .then(server => {
        if (server) replace(id, () => server)
      })
      .catch(e => {
        clearAnim(id)
        replace(id, () => snapshot)
        setToast(t => (t?.kind === "undo" && t.id === id ? null : t))
        showError(`Couldn't mark "${snapshot.title}" done`, `PATCH done: ${errText(e)}`)
      })
  }, [clearAnim, markFresh, patch, replace, showError, showToast])

  /** Done card (or a card mid-animation) → back to open, where it was. */
  const reopen = useCallback((id: string) => {
    const current = items?.find(i => i.id === id)
    if (!current) return
    const wasAnimating = !!animRef.current[id]
    clearAnim(id)
    replace(id, i => ({ ...i, status: "open", done_at: null }))
    if (!wasAnimating) markFresh(id)
    patch(id, { status: "open" })
      .then(server => {
        if (server) replace(id, () => server)
      })
      .catch(e => {
        replace(id, () => ({ ...current, status: "done", done_at: current.done_at ?? new Date().toISOString() }))
        showError(`Couldn't reopen "${current.title}"`, `PATCH open: ${errText(e)}`)
      })
  }, [clearAnim, items, markFresh, patch, replace, showError])

  const onToggle = useCallback((item: BoardItem) => {
    if (item.status === "done") reopen(item.id)
    else complete(item)
  }, [complete, reopen])

  const undo = useCallback((id: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(null)
    reopen(id)
  }, [reopen])

  const save = useCallback((item: BoardItem, edit: BoardEdit) => {
    const before = items?.find(i => i.id === item.id) ?? item
    replace(item.id, i => ({ ...i, ...edit }))
    if (edit.lane && edit.lane !== before.lane) markFresh(item.id)
    patch(item.id, edit as Record<string, unknown>)
      .then(server => {
        if (server) replace(item.id, () => server)
      })
      .catch(e => {
        replace(item.id, () => before)
        showError(`Couldn't save "${before.title}"`, `PATCH edit: ${errText(e)}`)
      })
  }, [items, markFresh, patch, replace, showError])

  const add = useCallback(async (e: FormEvent) => {
    e.preventDefault()
    const title = draft.trim()
    if (!title || adding) return
    setAdding(true)
    setDraft("")
    inflight.current += 1
    dirtyAt.current = Date.now()
    try {
      const data = await api<{ item: BoardItem }>("POST", { title, lane: "you" })
      if (!data) return
      setItems(prev => [data.item, ...(prev ?? []).filter(i => i.id !== data.item.id)])
      setPinned(p => [data.item.id, ...p])
      markFresh(data.item.id)
    } catch (err) {
      setDraft(d => d || title)
      showError(`Couldn't add "${title}"`, `POST: ${errText(err)}`)
    } finally {
      inflight.current -= 1
      dirtyAt.current = Date.now()
      setAdding(false)
    }
  }, [adding, draft, markFresh, showError])

  const focusAdd = () => {
    addRef.current?.focus()
    addRef.current?.scrollIntoView({ block: "center", behavior: reduceMotion.current ? "auto" : "smooth" })
  }

  const closeSheet = useCallback(() => setEditing(null), [])

  // ---- derived ------------------------------------------------------------

  const lanes = useMemo(() => {
    const all = items ?? []
    const byLane = {} as Record<BoardLane, BoardItem[]>
    // On hold with a future date → the folded group (status ignored so a card
    // mid-"done" animation stays where it is until it has collapsed).
    const heldNow = (i: BoardItem) => i.on_hold && !!i.due_date && i.due_date > today
    const live = (i: BoardItem) => i.status === "open" || !!anim[i.id]
    for (const l of BOARD_LANES) {
      // A card mid-animation stays in its lane until it has collapsed.
      const inLane = all.filter(i => i.lane === l && live(i) && !heldNow(i))
      const top = pinned.map(id => inLane.find(i => i.id === id)).filter((i): i is BoardItem => !!i)
      byLane[l] = [...top, ...inLane.filter(i => !pinned.includes(i.id)).sort(sortOpen)]
    }
    const held = all.filter(i => live(i) && heldNow(i)).sort(sortOpen)
    const done = all.filter(i => i.status === "done" && !anim[i.id]).sort(sortDone)
    return { byLane, held, done }
  }, [items, anim, pinned, today])

  const heldCount = lanes.held.filter(i => !anim[i.id]).length
  const openCount = (items ?? []).filter(i => i.status === "open" && !anim[i.id]).length - heldCount

  // ---- render -------------------------------------------------------------

  return (
    <div className="text-signal-ink">
      <style>{BOARD_CSS}</style>

      {/* Header */}
      <header className="-mx-4 md:-mx-6 px-4 md:px-6 -mt-1 md:-mt-1 pb-3.5 md:pb-4 border-b border-signal-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-[30px] h-[30px] md:w-[30px] md:h-[30px] rounded-lg shrink-0 bg-gradient-to-br from-signal-accent to-[#0ea5e9]" aria-hidden />
          <div className="min-w-0 flex flex-col md:flex-row md:items-baseline md:gap-3">
            <h1 className="text-[28px] md:text-[22px] font-bold tracking-[-0.02em] leading-tight">Board</h1>
            <span className="text-[13px] text-signal-muted truncate" suppressHydrationWarning>
              {headerDate(new Date())} · {items ? `${openCount} open${heldCount ? ` · ${heldCount} on hold` : ""}` : "…"}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={focusAdd}
          className="shrink-0 inline-flex items-center gap-1.5 min-h-[44px] md:min-h-[40px] px-4 rounded-full bg-signal-accent text-[#06231f] text-[15px] md:text-sm font-bold active:brightness-90"
        >
          <Plus className="w-4 h-4" strokeWidth={3} /> Add
        </button>
      </header>

      {/* Quick add */}
      <form
        onSubmit={add}
        className="mt-3 md:mt-4 flex items-center gap-2.5 rounded-xl bg-signal-card border border-signal-border pl-3.5 pr-2 focus-within:border-signal-accent/50"
      >
        {adding ? (
          <Loader2 className="w-[18px] h-[18px] text-signal-accent animate-spin shrink-0" />
        ) : (
          <Plus className="w-[18px] h-[18px] text-signal-accent shrink-0" strokeWidth={3} />
        )}
        <input
          ref={addRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Add a project…"
          aria-label="Add a card"
          enterKeyHint="done"
          autoComplete="off"
          maxLength={300}
          className="flex-1 min-w-0 min-h-[46px] bg-transparent text-base md:text-sm text-signal-ink placeholder:text-signal-muted focus:outline-none"
        />
        {draft.trim() && (
          <button
            type="submit"
            disabled={adding}
            className="shrink-0 min-h-[36px] px-3 rounded-lg bg-signal-card2 text-signal-accent text-sm font-semibold disabled:opacity-50"
          >
            Add
          </button>
        )}
      </form>

      {/* Lanes */}
      {!items ? (
        <div className="mt-6 text-sm text-signal-muted">
          {loadError ? (
            <div className="rounded-xl border border-signal-bad/40 bg-signal-bad/[.08] p-4 text-signal-ink">
              <p className="font-semibold">Couldn&apos;t load the board.</p>
              <p className="mt-1 text-signal-muted break-words">{loadError}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-3 min-h-[40px] px-4 rounded-lg bg-signal-card2 text-signal-accent font-semibold"
              >
                Try again
              </button>
            </div>
          ) : (
            "Loading…"
          )}
        </div>
      ) : (
        <div className="mt-1 md:mt-5 md:grid md:grid-cols-2 lg:grid-cols-4 md:gap-3 xl:gap-4 md:items-start">
          {BOARD_LANES.map(l => (
            <Lane key={l} title={BOARD_LANE_LABEL[l]} dot={LANE_DOT[l]} count={lanes.byLane[l].filter(i => !anim[i.id]).length}>
              {lanes.byLane[l].length === 0 ? (
                <Empty />
              ) : (
                lanes.byLane[l].map(i => (
                  <BoardCard
                    key={i.id}
                    item={i}
                    today={today}
                    phase={anim[i.id] ?? "idle"}
                    fresh={!!fresh[i.id]}
                    onToggle={onToggle}
                    onOpen={setEditing}
                  />
                ))
              )}
            </Lane>
          ))}
          <div className="md:space-y-3 xl:space-y-4 min-w-0">
          <Lane
            title="On hold"
            dot={LANE_DOT.hold}
            count={heldCount}
            toggle={{ open: showHold, onToggle: () => setShowHold(v => !v), everywhere: true }}
          >
            {showHold ? (
              lanes.held.length === 0 ? (
                <Empty text="Nothing on hold." />
              ) : (
                lanes.held.map(i => (
                  <BoardCard
                    key={i.id}
                    item={i}
                    today={today}
                    phase={anim[i.id] ?? "idle"}
                    fresh={!!fresh[i.id]}
                    onToggle={onToggle}
                    onOpen={setEditing}
                  />
                ))
              )
            ) : (
              <p className="px-0.5 md:px-1.5 py-3 md:py-2 text-sm text-signal-muted/80 border-b border-signal-border md:border-0">
                {heldCount ? "Nothing needed from you until their dates. Each comes back by itself." : "Nothing on hold."}
              </p>
            )}
          </Lane>
          <Lane
            title="Done this week"
            dot={LANE_DOT.done}
            count={lanes.done.length}
            toggle={{ open: showDone, onToggle: () => setShowDone(v => !v) }}
          >
            <div className={cn(!showDone && "hidden md:block")}>
              {lanes.done.length === 0 ? (
                <Empty text="Nothing finished yet this week." />
              ) : (
                lanes.done.map(i => (
                  <BoardCard
                    key={i.id}
                    item={i}
                    today={today}
                    phase="idle"
                    fresh={!!fresh[i.id]}
                    onToggle={onToggle}
                    onOpen={setEditing}
                  />
                ))
              )}
            </div>
          </Lane>
          </div>
        </div>
      )}

      {/* Diagnostics */}
      <p className="mt-6 md:mt-4 text-[11px] text-signal-muted/70 break-words" suppressHydrationWarning>
        {VERSION} · {items ? items.length : 0} cards · {loadedAt ? `loaded ${clockTime(loadedAt)}` : "not loaded"}
        {lastError ? ` · last error: ${lastError}` : ""}
      </p>

      {/* Undo / error pill */}
      {toast && (
        <div className="fixed inset-x-0 z-40 flex justify-center px-4 pointer-events-none bottom-[calc(env(safe-area-inset-bottom)+76px)] md:bottom-6">
          <div
            key={toast.kind === "undo" ? `u-${toast.id}` : `e-${toast.message}`}
            role="status"
            aria-live="polite"
            className={cn(
              "board-toast pointer-events-auto flex items-center gap-3 max-w-full rounded-full border pl-4 pr-1.5 shadow-[0_8px_30px_rgba(0,0,0,.45)] text-[14px] md:text-[13.5px]",
              toast.kind === "error" ? "bg-[#2a1520] border-signal-bad/50" : "bg-[#1b2742] border-[#2a3a5e]",
            )}
          >
            {toast.kind === "undo" ? (
              <>
                <span className="min-w-0 truncate py-2.5">Done: {toast.title}</span>
                <button
                  type="button"
                  onClick={() => undo(toast.id)}
                  className="shrink-0 min-h-[40px] px-3 rounded-full font-bold text-signal-accent active:bg-white/5"
                >
                  Undo
                </button>
              </>
            ) : (
              <>
                <span className="min-w-0 truncate py-2.5 text-[#ffb4b4]">{toast.message}</span>
                <button
                  type="button"
                  onClick={() => setToast(null)}
                  className="shrink-0 min-h-[40px] px-3 rounded-full font-semibold text-signal-muted"
                >
                  OK
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {editing && (
        <BoardSheet key={editing.id} item={editing} onClose={closeSheet} onSave={save} />
      )}
    </div>
  )
}

function Lane({
  title,
  dot,
  count,
  toggle,
  children,
}: {
  title: string
  dot: string
  count: number
  toggle?: { open: boolean; onToggle: () => void; everywhere?: boolean }
  children: React.ReactNode
}) {
  return (
    <section className="mt-6 md:mt-0 md:rounded-2xl md:border md:border-signal-border md:bg-signal-card/55 md:p-3 lg:p-2.5 xl:p-3 min-w-0">
      <div className="flex items-center justify-between gap-2 px-0.5 md:px-1.5 pb-1.5 md:pb-2.5 md:pt-1">
        <h2 className="flex items-center gap-2 text-[20px] md:text-[15px] lg:text-[14px] xl:text-[15px] font-bold tracking-[-0.01em] min-w-0">
          <span className="w-[9px] h-[9px] rounded-full shrink-0" style={{ background: dot }} />
          <span className="truncate">{title}</span>
        </h2>
        <div className="flex items-center gap-1 shrink-0">
          {toggle && (
            <button
              type="button"
              onClick={toggle.onToggle}
              aria-expanded={toggle.open}
              className={cn("min-h-[40px] md:min-h-[32px] px-2.5 text-[15px] md:text-[13px] font-semibold text-signal-accent", !toggle.everywhere && "md:hidden")}
            >
              {toggle.open ? "Hide" : "Show"}
            </button>
          )}
          <span className="rounded-full bg-signal-card2 px-[9px] py-0.5 text-[13px] font-semibold text-signal-muted tabular-nums">
            {count}
          </span>
        </div>
      </div>
      {children}
    </section>
  )
}

function Empty({ text = "Nothing here." }: { text?: string }) {
  return <p className="px-0.5 md:px-1.5 py-3 md:py-2 text-sm text-signal-muted/80 border-b border-signal-border md:border-0">{text}</p>
}
