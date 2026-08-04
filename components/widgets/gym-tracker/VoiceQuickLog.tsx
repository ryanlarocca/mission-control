"use client"

import { useRef, useState } from "react"
import { Mic, Check, X } from "lucide-react"
import { matchExercise, parseVoiceQuickLog, type StrengthCard } from "@/lib/gymTracker"

function todayLocal(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number
  start: () => void; stop: () => void
  onresult: ((e: { results: { 0: { 0: { transcript: string } } } }) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
}
function getSR(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

// Parsed-and-ready-to-confirm state.
interface Draft {
  exerciseId: string | null     // matched card, or null if we'd create a new one
  exerciseName: string          // matched name, or the spoken text for a new one
  weight: number
  reps: number
  notes: string | null
  needsCreate: boolean
}

export function VoiceQuickLog({
  cards,
  onLogged,
}: {
  cards: StrengthCard[]
  onLogged: (result: { exerciseName: string; isNewPr: boolean }) => void
}) {
  const supported = useRef(getSR() !== null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function reset() {
    setDraft(null); setProblem(null); setHeard(null)
  }

  function start() {
    const Ctor = getSR()
    if (!Ctor) return
    reset()
    const rec = new Ctor()
    rec.lang = "en-US"; rec.continuous = false; rec.interimResults = false; rec.maxAlternatives = 1
    rec.onresult = (e) => handleTranscript(e.results[0][0].transcript)
    rec.onerror = () => setListening(false)
    rec.onend = () => setListening(false)
    recRef.current = rec
    setListening(true)
    rec.start()
    window.setTimeout(() => { try { rec.stop() } catch { /* noop */ } }, 5000)
  }

  function handleTranscript(transcript: string) {
    setHeard(transcript)
    const parsed = parseVoiceQuickLog(transcript)
    if (parsed.weight == null || parsed.reps == null) {
      setProblem("Couldn't catch the weight and reps — try “bench press 225 for 5”.")
      return
    }
    if (!parsed.exerciseText) {
      setProblem("Couldn't catch which exercise — say its name first.")
      return
    }
    const match = matchExercise(parsed.exerciseText, cards)
    setDraft({
      exerciseId: match?.id ?? null,
      exerciseName: match?.name ?? titleCase(parsed.exerciseText),
      weight: parsed.weight,
      reps: parsed.reps,
      notes: parsed.notes ?? null,
      needsCreate: !match,
    })
  }

  function toggle() {
    if (listening) { try { recRef.current?.stop() } catch { /* noop */ }; setListening(false) }
    else start()
  }

  async function confirm() {
    if (!draft) return
    setSaving(true)
    setProblem(null)
    try {
      let exerciseId = draft.exerciseId
      if (draft.needsCreate || !exerciseId) {
        const res = await fetch("/api/physiq/gym/exercises", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: draft.exerciseName, category: "strength" }),
        })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error || "Couldn't create exercise")
        exerciseId = j.id
      }
      const res = await fetch("/api/physiq/gym/strength", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exerciseId, date: todayLocal(), weight_lbs: draft.weight, reps: draft.reps, notes: draft.notes,
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || "Couldn't log set")
      onLogged({ exerciseName: draft.exerciseName, isNewPr: !!j.isNewPr })
      reset()
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't log set")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          disabled={!supported.current}
          title={supported.current ? "Tap and say a set" : "Voice input not supported in this browser."}
          className={`shrink-0 h-11 w-11 rounded-full flex items-center justify-center transition-colors ${
            listening ? "bg-red-500 text-white animate-pulse"
            : supported.current ? "bg-amber-500 text-zinc-950 hover:bg-amber-400"
            : "bg-zinc-800 text-zinc-700 cursor-not-allowed"
          }`}
        >
          <Mic size={20} />
        </button>
        <div className="min-w-0 flex-1">
          {listening ? (
            <p className="text-sm text-zinc-300">Listening… say e.g. &ldquo;bench press 225 for 5&rdquo;</p>
          ) : draft ? (
            <p className="text-sm text-zinc-300 truncate">
              {draft.needsCreate ? <span className="text-amber-400">new · </span> : null}
              <span className="text-zinc-100 font-medium">{draft.exerciseName}</span>
              {" · "}{draft.weight} × {draft.reps}
              {draft.notes ? <span className="text-zinc-500"> · {draft.notes}</span> : null}
            </p>
          ) : problem ? (
            <p className="text-sm text-red-400">{problem}</p>
          ) : (
            <p className="text-sm text-zinc-500">Quick-log a set by voice</p>
          )}
          {heard && !draft && !listening && (
            <p className="text-[11px] text-zinc-600 truncate">Heard: &ldquo;{heard}&rdquo;</p>
          )}
        </div>

        {draft && (
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={reset} disabled={saving} className="h-9 w-9 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center" aria-label="Cancel">
              <X size={16} />
            </button>
            <button onClick={confirm} disabled={saving} className="h-9 px-3 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 text-sm font-semibold flex items-center gap-1">
              <Check size={16} /> {saving ? "…" : draft.needsCreate ? "Create & Log" : "Log"}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase())
}
