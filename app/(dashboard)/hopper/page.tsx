"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { ChevronDown, ChevronRight, Loader2, MoreVertical, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { handleSessionExpired } from "@/lib/session-expired"

// The Hopper (2026-11-10): Ryan's list of tools and ideas that aren't on day
// one. Read it, add to it from the phone, mark an item picked up or dropped.
// Dropped items hide; picked-up items fold under a collapsed heading.

type Item = {
  id: string
  title: string
  note: string | null
  kind: "tool" | "idea"
  status: "open" | "picked_up" | "dropped"
  created_at: string
}

export default function HopperPage() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [note, setNote] = useState("")
  const [kind, setKind] = useState<"idea" | "tool">("idea")
  const [saving, setSaving] = useState(false)
  const [formMsg, setFormMsg] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [showPicked, setShowPicked] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/hopper", { cache: "no-store" })
      if (handleSessionExpired(res)) return
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      setItems(body.items as Item[])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || saving) return
    setSaving(true)
    setFormMsg(null)
    try {
      const res = await fetch("/api/hopper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, note, kind }),
      })
      if (handleSessionExpired(res)) return
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      setItems(prev => [body.item as Item, ...(prev ?? [])])
      setTitle("")
      setNote("")
      setFormMsg("Added.")
    } catch (err) {
      setFormMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function setStatus(item: Item, status: Item["status"]) {
    setMenuFor(null)
    const before = items
    setItems(prev => prev?.map(i => (i.id === item.id ? { ...i, status } : i)) ?? prev)
    try {
      const res = await fetch("/api/hopper", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status }),
      })
      if (handleSessionExpired(res)) return
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
    } catch (err) {
      setItems(before)
      setFormMsg(`Couldn't update "${item.title}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const open = (items ?? []).filter(i => i.status === "open")
  const tools = open.filter(i => i.kind === "tool")
  const ideas = open.filter(i => i.kind !== "tool")
  const picked = (items ?? []).filter(i => i.status === "picked_up")

  return (
    <div className="max-w-2xl text-signal-ink">
      <h1 className="text-[26px] md:text-2xl font-bold tracking-tight">The Hopper</h1>
      <p className="text-sm text-signal-muted mt-1 mb-4">Tools and ideas for later.</p>

      <form onSubmit={add} className="bg-signal-card border border-signal-border rounded-md p-3 flex flex-col gap-2">
        <label className="text-[11px] uppercase tracking-[0.08em] text-signal-muted" htmlFor="hopper-title">Add an idea</label>
        <input
          id="hopper-title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="What is it?"
          enterKeyHint="next"
          autoComplete="off"
          maxLength={200}
          className="w-full min-h-[44px] rounded-md bg-signal-bg border border-signal-border px-3 text-base md:text-sm text-signal-ink placeholder:text-signal-muted focus:outline-none focus:border-signal-accent/60"
        />
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="A line about it (optional)"
          rows={2}
          maxLength={1000}
          className="w-full rounded-md bg-signal-bg border border-signal-border px-3 py-2.5 text-base md:text-sm text-signal-ink placeholder:text-signal-muted focus:outline-none focus:border-signal-accent/60 resize-none"
        />
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-signal-border overflow-hidden shrink-0" role="group" aria-label="Kind">
            {(["idea", "tool"] as const).map(k => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                aria-pressed={kind === k}
                className={cn(
                  "min-h-[44px] px-3.5 text-sm",
                  kind === k ? "bg-signal-card2 text-signal-accent" : "text-signal-muted",
                )}
              >
                {k === "idea" ? "Idea" : "Tool"}
              </button>
            ))}
          </div>
          <span className="min-w-0 flex-1 truncate text-xs text-signal-muted">{formMsg}</span>
          <button
            type="submit"
            disabled={!title.trim() || saving}
            className="shrink-0 inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-md bg-signal-accent text-signal-bg text-sm font-semibold disabled:opacity-40"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add
          </button>
        </div>
      </form>

      {!items ? (
        <p className="mt-6 text-sm text-signal-muted">{error ? "Couldn't load the Hopper right now." : "Loading…"}</p>
      ) : (
        <>
          <Group label="Tools" items={tools} menuFor={menuFor} setMenuFor={setMenuFor} onStatus={setStatus} />
          <Group label="Ideas" items={ideas} menuFor={menuFor} setMenuFor={setMenuFor} onStatus={setStatus} />
          {picked.length > 0 && (
            <section className="mt-6">
              <button
                type="button"
                onClick={() => setShowPicked(v => !v)}
                className="flex items-center gap-1.5 min-h-[44px] text-xs uppercase tracking-[0.08em] font-semibold text-signal-muted"
              >
                {showPicked ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                Picked up · {picked.length}
              </button>
              {showPicked && <ItemList items={picked} menuFor={menuFor} setMenuFor={setMenuFor} onStatus={setStatus} />}
            </section>
          )}
        </>
      )}
    </div>
  )
}

type ListProps = {
  items: Item[]
  menuFor: string | null
  setMenuFor: (id: string | null) => void
  onStatus: (item: Item, status: Item["status"]) => void
}

function Group({ label, ...rest }: ListProps & { label: string }) {
  return (
    <section className="mt-6">
      <h2 className="text-xs uppercase tracking-[0.08em] font-semibold text-signal-muted mb-2">
        {label} <span className="font-num">· {rest.items.length}</span>
      </h2>
      {rest.items.length === 0 ? (
        <p className="text-sm text-signal-muted">Nothing here.</p>
      ) : (
        <ItemList {...rest} />
      )}
    </section>
  )
}

function ItemList({ items, menuFor, setMenuFor, onStatus }: ListProps) {
  return (
    <div className="bg-signal-card border border-signal-border rounded-md">
      {items.map(item => (
        <div key={item.id} className="relative flex items-start gap-2 pl-3.5 pr-1 py-2 border-t border-signal-border first:border-t-0">
          <div className="min-w-0 flex-1 py-1">
            <div className={cn("text-sm font-semibold", item.status === "picked_up" && "text-signal-muted")}>{item.title}</div>
            {item.note && <div className="text-xs text-signal-muted mt-0.5 truncate">{item.note}</div>}
          </div>
          <ItemMenu item={item} open={menuFor === item.id} onToggle={() => setMenuFor(menuFor === item.id ? null : item.id)} onClose={() => setMenuFor(null)} onStatus={onStatus} />
        </div>
      ))}
    </div>
  )
}

function ItemMenu({ item, open, onToggle, onClose, onStatus }: {
  item: Item; open: boolean; onToggle: () => void; onClose: () => void; onStatus: ListProps["onStatus"]
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [open, onClose])

  const actions: { label: string; status: Item["status"] }[] =
    item.status === "picked_up"
      ? [{ label: "Back on the list", status: "open" }, { label: "Drop it", status: "dropped" }]
      : [{ label: "Mark picked up", status: "picked_up" }, { label: "Drop it", status: "dropped" }]

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={onToggle}
        aria-label={`Options for ${item.title}`}
        aria-expanded={open}
        className="w-11 h-11 flex items-center justify-center text-signal-muted hover:text-signal-ink"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute right-1 top-11 z-30 w-48 rounded-md border border-signal-border bg-signal-card2 shadow-lg py-1">
          {actions.map(a => (
            <button
              key={a.status}
              type="button"
              onClick={() => onStatus(item, a.status)}
              className="w-full text-left px-3 min-h-[44px] text-sm text-signal-ink hover:bg-signal-card"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
