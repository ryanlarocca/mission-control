"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, Pencil, Phone } from "lucide-react"

// The phone block on a Relationships card (2026-10-15): the main number with
// a pencil to edit it inline, and each extra number ("also:") with a
// "make main" link. Both post to /api/crms/phone; the parent owns the
// contact state and the phone-keyed caches (touches, thread), so it gets
// the new numbers back and refetches.

export function formatPhone10(p: string): string {
  const d = (p || "").replace(/\D/g, "")
  if (d.length !== 10) return p || "—"
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

interface Props {
  id: string
  phone: string          // 10 digits, or "" for a phoneless contact
  altPhones: string[]    // 10 digits each
  onChanged: (phone: string, altPhones: string[]) => void
  withIcon?: boolean
}

export function RelationshipPhone({ id, phone, altPhones, onChanged, withIcon }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(phone)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  // A new contact in the same mount (queue advance) resets the editor.
  useEffect(() => {
    setEditing(false)
    setDraft(phone)
    setError(null)
  }, [id, phone])

  async function save(next: string) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/crms/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, phone: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Couldn't save the number")
        return
      }
      setEditing(false)
      onChanged(String(data.phone ?? ""), Array.isArray(data.altPhones) ? data.altPhones : [])
    } catch {
      setError("Couldn't save the number")
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setEditing(false)
    setDraft(phone)
    setError(null)
  }

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="flex items-center gap-1.5">
        {withIcon && <Phone className="w-3 h-3 text-zinc-600 shrink-0" />}
        {editing ? (
          <>
            <input
              ref={inputRef}
              type="tel"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); save(draft) }
                else if (e.key === "Escape") { e.preventDefault(); cancel() }
              }}
              disabled={saving}
              placeholder="10-digit number"
              className="bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-200 w-36 focus:outline-none focus:border-zinc-500 disabled:opacity-50"
            />
            {saving && <Loader2 className="w-3 h-3 text-zinc-500 animate-spin" />}
          </>
        ) : (
          <>
            <span>{phone || "—"}</span>
            <button
              type="button"
              onClick={() => { setDraft(phone); setEditing(true) }}
              disabled={saving}
              title="Change the number the Call button dials"
              aria-label="Edit phone"
              className="p-0.5"
            >
              <Pencil className="w-3 h-3 text-zinc-600 hover:text-zinc-300" />
            </button>
          </>
        )}
      </span>
      {error && <span className="text-red-400 font-sans">{error}</span>}
      {altPhones.map(p => (
        <span key={p} className="text-zinc-500 flex items-center gap-2">
          <span>also: {formatPhone10(p)}</span>
          <button
            type="button"
            onClick={() => save(p)}
            disabled={saving}
            title="Make this the number the Call button dials"
            className="text-zinc-600 hover:text-zinc-300 font-sans disabled:opacity-50"
          >
            make main
          </button>
        </span>
      ))}
    </div>
  )
}
