"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { Loader2, Pencil } from "lucide-react"

// Name or email on a Relationships card with a pencil to edit it inline
// (2026-11-11) — the same feel as RelationshipPhone. Posts to
// /api/crms/details; the parent owns the contact state and gets the saved
// value back.

interface Props {
  id: string
  field: "name" | "email"
  value: string
  onChanged: (value: string) => void
  // What shows when not editing; defaults to the value (or "—").
  display?: ReactNode
}

export function RelationshipField({ id, field, value, onChanged, display }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  // A new contact in the same mount (queue advance) resets the editor.
  useEffect(() => {
    setEditing(false)
    setDraft(value)
    setError(null)
  }, [id, value])

  async function save() {
    if (saving) return
    if (draft.trim() === value.trim()) { setEditing(false); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/crms/details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, [field]: draft }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : `Couldn't save the ${field}`)
        return
      }
      setEditing(false)
      onChanged(String(data[field] ?? ""))
    } catch {
      setError(`Couldn't save the ${field}`)
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setEditing(false)
    setDraft(value)
    setError(null)
  }

  return (
    <span className="flex flex-col gap-0.5 min-w-0">
      <span className="flex items-center gap-1.5 min-w-0">
        {editing ? (
          <>
            <input
              ref={inputRef}
              type={field === "email" ? "email" : "text"}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); save() }
                else if (e.key === "Escape") { e.preventDefault(); cancel() }
              }}
              disabled={saving}
              placeholder={field === "email" ? "name@example.com" : "Name"}
              autoCapitalize={field === "email" ? "off" : "words"}
              autoCorrect="off"
              className="bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 min-w-0 w-56 focus:outline-none focus:border-zinc-500 disabled:opacity-50"
              style={{ fontSize: "16px" }}
            />
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="text-xs text-emerald-400 hover:text-emerald-300 font-sans disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="text-xs text-zinc-500 hover:text-zinc-300 font-sans disabled:opacity-50"
            >
              Cancel
            </button>
            {saving && <Loader2 className="w-3 h-3 text-zinc-500 animate-spin shrink-0" />}
          </>
        ) : (
          <>
            {display ?? <span className="truncate">{value || "—"}</span>}
            <button
              type="button"
              onClick={() => { setDraft(value); setEditing(true) }}
              title={field === "email" ? "Change their email" : "Change their name"}
              aria-label={`Edit ${field}`}
              className="p-0.5 shrink-0"
            >
              <Pencil className="w-3 h-3 text-zinc-600 hover:text-zinc-300" />
            </button>
          </>
        )}
      </span>
      {error && <span className="text-xs text-red-400 font-sans">{error}</span>}
    </span>
  )
}
