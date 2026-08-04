"use client"

import { useEffect, useRef, useState } from "react"
import { X } from "lucide-react"

export function AddExerciseModal({
  defaultCategory = "strength",
  onClose,
  onAdded,
}: {
  defaultCategory?: "strength" | "cardio"
  onClose: () => void
  onAdded: () => void
}) {
  const [name, setName] = useState("")
  const [category, setCategory] = useState<"strength" | "cardio">(defaultCategory)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => { nameRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) { setError("Enter a name."); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/physiq/gym/exercises", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, category }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to add")
      onAdded()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add")
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-sm bg-zinc-950 border-t sm:border border-zinc-800 sm:rounded-lg rounded-t-2xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-zinc-100 font-semibold">Add Exercise</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 p-1" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <label className="block">
          <span className="block text-xs text-zinc-400 mb-1">Name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Overhead Press"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-zinc-100 focus:border-zinc-600 outline-none"
          />
        </label>

        <div>
          <span className="block text-xs text-zinc-400 mb-1">Category</span>
          <div className="flex gap-2">
            {(["strength", "cardio"] as const).map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`flex-1 rounded-lg py-2 text-sm capitalize transition-colors ${
                  category === c
                    ? "bg-zinc-700 text-zinc-100"
                    : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <button
          onClick={save}
          disabled={saving}
          className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 rounded-lg py-2.5 text-sm font-semibold"
        >
          {saving ? "Adding…" : "Add Exercise"}
        </button>
      </div>
    </div>
  )
}
