"use client"

import { useEffect, useRef, useState } from "react"
import { Plus, X } from "lucide-react"
import { formatShortDate, type GymCardio } from "@/lib/gymTracker"

function todayLocal(): string {
  const d = new Date()
  const off = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - off).toISOString().slice(0, 10)
}

function summary(c: GymCardio): string {
  const parts: string[] = []
  if (c.duration_minutes != null) parts.push(`${c.duration_minutes} min`)
  if (c.speed_mph != null) parts.push(`${c.speed_mph} mph`)
  if (c.incline_pct != null) parts.push(`${c.incline_pct}% incline`)
  return parts.join(" · ")
}

export function CardioTab() {
  const [sessions, setSessions] = useState<GymCardio[] | null>(null)
  const [showLog, setShowLog] = useState(false)

  async function load() {
    const res = await fetch("/api/physiq/gym/cardio")
    const json = await res.json()
    setSessions(json.sessions ?? [])
  }
  useEffect(() => { load() }, [])

  return (
    <div className="space-y-3">
      <button
        onClick={() => setShowLog(true)}
        className="flex items-center gap-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg px-3 py-2"
      >
        <Plus size={16} /> Log Cardio
      </button>

      {sessions === null ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 bg-zinc-800 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-zinc-500 py-8 text-center">No cardio logged yet. Tap + to add.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 border border-zinc-800 rounded-lg overflow-hidden">
          {sessions.map((c) => (
            <li key={c.id} className="bg-zinc-900 px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-zinc-100 font-medium">{c.exercise_name}</span>
                <span className="text-xs text-zinc-500">{formatShortDate(c.date)}</span>
              </div>
              {summary(c) && <div className="text-sm text-zinc-400 mt-0.5">{summary(c)}</div>}
              {c.notes && <div className="text-xs text-zinc-500 mt-0.5">{c.notes}</div>}
            </li>
          ))}
        </ul>
      )}

      {showLog && (
        <LogCardioModal
          onClose={() => setShowLog(false)}
          onSaved={() => { setShowLog(false); load() }}
        />
      )}
    </div>
  )
}

function LogCardioModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [exerciseName, setExerciseName] = useState("")
  const [date, setDate] = useState(todayLocal())
  const [duration, setDuration] = useState("")
  const [speed, setSpeed] = useState("")
  const [incline, setIncline] = useState("")
  const [notes, setNotes] = useState("")
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
    if (!exerciseName.trim()) { setError("Enter an exercise name."); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/physiq/gym/cardio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          exercise_name: exerciseName.trim(),
          duration_minutes: duration || null,
          speed_mph: speed || null,
          incline_pct: incline || null,
          notes: notes.trim() || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to save")
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save")
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full sm:max-w-md bg-zinc-950 border-t sm:border border-zinc-800 sm:rounded-lg rounded-t-2xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-zinc-100 font-semibold">Log Cardio</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 p-1" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <label className="block">
          <span className="block text-xs text-zinc-400 mb-1">Exercise</span>
          <input
            ref={nameRef}
            value={exerciseName}
            onChange={(e) => setExerciseName(e.target.value)}
            placeholder="Treadmill"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-zinc-100 focus:border-zinc-600 outline-none"
          />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label>
            <span className="block text-xs text-zinc-400 mb-1">Duration (min)</span>
            <input inputMode="decimal" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="30"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 outline-none" />
          </label>
          <label>
            <span className="block text-xs text-zinc-400 mb-1">Speed (mph)</span>
            <input inputMode="decimal" value={speed} onChange={(e) => setSpeed(e.target.value)} placeholder="6.0"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 outline-none" />
          </label>
          <label>
            <span className="block text-xs text-zinc-400 mb-1">Incline (%)</span>
            <input inputMode="decimal" value={incline} onChange={(e) => setIncline(e.target.value)} placeholder="2.0"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 outline-none" />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className="block text-xs text-zinc-400 mb-1">Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 outline-none" />
          </label>
          <label>
            <span className="block text-xs text-zinc-400 mb-1">Notes</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="easy pace"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 outline-none" />
          </label>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg py-3 text-sm font-medium">Cancel</button>
          <button onClick={save} disabled={saving} className="flex-1 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 rounded-lg py-3 text-sm font-semibold">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
