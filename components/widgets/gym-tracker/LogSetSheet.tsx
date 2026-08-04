"use client"

import { useEffect, useRef, useState } from "react"
import { Mic, X } from "lucide-react"
import { formatLoad, parseVoiceSet, type StrengthCard } from "@/lib/gymTracker"

// Local YYYY-MM-DD (no UTC shift, so "today" is the user's today).
function todayLocal(): string {
  const d = new Date()
  const off = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - off).toISOString().slice(0, 10)
}

// Minimal Web Speech API typing — not in lib.dom by default.
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  onresult: ((e: { results: { 0: { 0: { transcript: string } } } }) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface SaveSetResult {
  isNewPr: boolean
  exerciseName: string
}

export function LogSetSheet({
  card,
  onClose,
  onSaved,
}: {
  card: StrengthCard
  onClose: () => void
  onSaved: (result: SaveSetResult) => void
}) {
  const [weight, setWeight] = useState("")
  const [reps, setReps] = useState("")
  const [date, setDate] = useState(todayLocal())
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const speechSupported = useRef(getSpeechRecognition() !== null)

  // Pre-fill with the PR as a hint? No — leave blank so Ryan types/speaks the
  // new set. Focus weight on open.
  const weightRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    weightRef.current?.focus()
  }, [])

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  function startListening() {
    const Ctor = getSpeechRecognition()
    if (!Ctor) return
    setError(null)
    setHeard(null)
    const rec = new Ctor()
    rec.lang = "en-US"
    rec.continuous = false
    rec.interimResults = false
    rec.maxAlternatives = 1
    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript
      setHeard(transcript)
      const parsed = parseVoiceSet(transcript)
      if (parsed.weight != null) setWeight(String(parsed.weight))
      if (parsed.reps != null) setReps(String(parsed.reps))
      if (parsed.notes) setNotes(parsed.notes)
    }
    rec.onerror = () => { setListening(false) }
    rec.onend = () => { setListening(false) }
    recognitionRef.current = rec
    setListening(true)
    rec.start()
    // Hard stop after 5s in case onend doesn't fire.
    window.setTimeout(() => { try { rec.stop() } catch { /* noop */ } }, 5000)
  }

  function toggleMic() {
    if (listening) {
      try { recognitionRef.current?.stop() } catch { /* noop */ }
      setListening(false)
    } else {
      startListening()
    }
  }

  async function save() {
    setError(null)
    const w = parseFloat(weight)
    const r = parseFloat(reps)
    if (!Number.isFinite(w) || w <= 0) { setError("Enter a valid weight."); return }
    if (!Number.isFinite(r) || r <= 0) { setError("Enter valid reps."); return }
    setSaving(true)
    try {
      const res = await fetch("/api/physiq/gym/strength", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exerciseId: card.id,
          date,
          weight_lbs: w,
          reps: r,
          notes: notes.trim() || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to save")
      onSaved({ isNewPr: !!json.isNewPr, exerciseName: card.name })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save")
      setSaving(false)
    }
  }

  const pr = card.prSet

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-zinc-950 border-t sm:border border-zinc-800 sm:rounded-lg rounded-t-2xl p-5 space-y-4 animate-in slide-in-from-bottom-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-zinc-100 font-semibold text-lg">{card.name}</h2>
            {pr && (
              <p className="text-xs text-amber-400 mt-0.5">
                PR: {formatLoad(pr.weight_lbs, pr.reps)}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 p-1" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="flex items-end gap-3">
          <label className="flex-1">
            <span className="block text-xs text-zinc-400 mb-1">Weight (lbs)</span>
            <input
              ref={weightRef}
              inputMode="decimal"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              placeholder="225"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-3 text-xl text-zinc-100 text-center focus:border-zinc-600 outline-none"
            />
          </label>

          <button
            onClick={toggleMic}
            disabled={!speechSupported.current}
            title={speechSupported.current ? "Voice input" : "Voice input not supported in this browser."}
            aria-label="Voice input"
            className={`shrink-0 h-11 w-11 mb-0.5 rounded-full flex items-center justify-center transition-colors ${
              listening
                ? "bg-red-500 text-white animate-pulse"
                : speechSupported.current
                ? "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                : "bg-zinc-900 text-zinc-700 cursor-not-allowed"
            }`}
          >
            <Mic size={20} />
          </button>

          <label className="flex-1">
            <span className="block text-xs text-zinc-400 mb-1">Reps</span>
            <input
              inputMode="decimal"
              value={reps}
              onChange={(e) => setReps(e.target.value)}
              placeholder="5"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-3 text-xl text-zinc-100 text-center focus:border-zinc-600 outline-none"
            />
          </label>
        </div>

        {heard && (
          <p className="text-xs text-zinc-500">Heard: &ldquo;{heard}&rdquo;</p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className="block text-xs text-zinc-400 mb-1">Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 outline-none"
            />
          </label>
          <label>
            <span className="block text-xs text-zinc-400 mb-1">Notes</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="fatigued"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 outline-none"
            />
          </label>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex gap-3 pt-1">
          <button
            onClick={onClose}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg py-3 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 rounded-lg py-3 text-sm font-semibold"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
