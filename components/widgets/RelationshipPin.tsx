"use client"

import { useEffect, useRef, useState } from "react"
import { Pin } from "lucide-react"

// Pin button (2026-11-18), shared by the queue card and the detail modal.
// Pinned = someone who handed Ryan a lead: they sit in the Pinned section at
// the top of the Relationships tab until he unpins them. Clicking opens a
// small box for an optional note about the lead ("Santana Row lead"), with
// Pin / Save and, when pinned, Unpin. The parent owns the pin (optimistic
// update + revert, see CRMSTab handlePin).
export function PinButton({ pinned, note, onSave, onUnpin, align = "left" }: {
  pinned: boolean
  note: string
  onSave: (note: string) => void
  onUnpin: () => void
  align?: "left" | "right"
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(note)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setDraft(note)
    inputRef.current?.focus()
    const close = (e: MouseEvent | TouchEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    document.addEventListener("touchstart", close)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("touchstart", close)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => { onSave(draft.trim()); setOpen(false) }

  return (
    <div ref={boxRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-pressed={pinned}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded text-xs font-medium transition-colors ${
          pinned
            ? "bg-amber-900/40 border border-amber-800 text-amber-200"
            : "bg-zinc-900 border border-zinc-800 hover:border-amber-900/60 text-zinc-300 hover:text-amber-200"
        }`}
        title={pinned
          ? "Pinned to the top of the Relationships tab — click to edit the note or unpin"
          : "Pin to the top of the Relationships tab — for someone with a lead for you"}
      >
        <Pin className="w-3.5 h-3.5" />
        {pinned ? "Pinned ✓" : "Pin"}
      </button>
      {open && (
        <div className={`absolute z-30 top-full mt-1 w-64 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl p-2.5 space-y-2 ${align === "right" ? "right-0" : "left-0"}`}>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={140}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); save() }
              if (e.key === "Escape") setOpen(false)
            }}
            placeholder="What's the lead? (optional)"
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-800"
            style={{ fontSize: "16px" }}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              className="flex-1 text-xs font-medium px-3 py-1.5 min-h-[36px] rounded bg-amber-500/15 border border-amber-500/40 text-amber-200 hover:bg-amber-500/25"
            >
              {pinned ? "Save" : "Pin"}
            </button>
            {pinned && (
              <button
                type="button"
                onClick={() => { onUnpin(); setOpen(false) }}
                className="flex-1 text-xs font-medium px-3 py-1.5 min-h-[36px] rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-zinc-100"
              >
                Unpin
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
