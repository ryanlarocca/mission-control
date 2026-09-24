"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, Mic, MicOff, RefreshCw, ThumbsDown, X } from "lucide-react"
import {
  type Plan, MOMENT_LABELS, NEXT_ACTION_LABELS, TEMPERATURES, momentOptions, nextActionOptions,
} from "@/lib/reply-client"

// Reply Planner — the plan row + "Not right" control that sits above every
// composer. Controlled: the parent owns the plan and the draft; this only
// renders the chips and reports changes. A chip change → onPlanChange (the
// parent regenerates). "Not right" → one sentence → onRegenerate(why).

interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}
function getSpeech(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export function ReplyPlanner(p: {
  kind: "lead" | "relationship"
  plan: Plan | null
  busy: boolean
  error: string | null
  onPlanChange: (plan: Plan) => void
  onRegenerate: (why?: string) => void
  status?: string | null
}) {
  const { kind, plan, busy } = p
  const [open, setOpen] = useState(false)
  const [why, setWhy] = useState("")
  const [listening, setListening] = useState(false)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const canListen = !!getSpeech()

  useEffect(() => () => { recRef.current?.stop() }, [])

  function toggleMic() {
    if (listening) { recRef.current?.stop(); setListening(false); return }
    const Ctor = getSpeech()
    if (!Ctor) { inputRef.current?.focus(); return }
    const rec = new Ctor()
    rec.lang = "en-US"; rec.interimResults = false; rec.continuous = false
    rec.onresult = (e) => {
      const t = Array.from({ length: e.results.length }, (_, i) => e.results[i][0]?.transcript ?? "").join(" ").trim()
      if (t) setWhy(prev => (prev ? `${prev} ${t}` : t))
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recRef.current = rec
    setListening(true)
    rec.start()
  }

  function submitWhy() {
    const text = why.trim()
    if (!text) return
    p.onRegenerate(text)
    setWhy("")
    setOpen(false)
  }

  const set = (patch: Partial<Plan>) => {
    if (!plan) return
    p.onPlanChange({ ...plan, ...patch, source: "ryan" })
  }
  const chip = "bg-zinc-900 border border-zinc-800 rounded-full px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600 appearance-none"

  return (
    <div className="mb-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-xs text-zinc-500">Plan</div>
        <div className="flex items-center gap-3">
          {busy && (
            <span className="text-[11px] text-zinc-500 inline-flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> {plan ? "Drafting from plan…" : "Planning…"}
            </span>
          )}
          {!busy && p.status && <span className="text-[11px] text-zinc-600 truncate max-w-[220px]">{p.status}</span>}
          <button
            onClick={() => setOpen(o => !o)}
            disabled={busy || !plan}
            className="text-[11px] text-amber-300 hover:text-amber-200 inline-flex items-center gap-1 whitespace-nowrap disabled:opacity-50"
            title="Say what's off; the draft is redone with that in mind and your reason is kept"
          >
            <ThumbsDown className="w-3 h-3" /> Not right
          </button>
          <button
            onClick={() => p.onRegenerate()}
            disabled={busy}
            className="text-[11px] text-purple-300 hover:text-purple-200 inline-flex items-center gap-1 whitespace-nowrap disabled:opacity-50"
            title="Draft again from the plan"
          >
            <RefreshCw className="w-3 h-3" /> {plan ? "Redraft" : "Plan + draft"}
          </button>
        </div>
      </div>

      {plan ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <select value={plan.moment} onChange={e => set({ moment: e.target.value })} disabled={busy} className={chip} title="What kind of moment this is">
            {momentOptions(kind).map(m => <option key={m} value={m}>{MOMENT_LABELS[m] ?? m}</option>)}
          </select>
          {kind === "lead" && (
            <select value={plan.temperature ?? ""} onChange={e => set({ temperature: e.target.value || null })} disabled={busy} className={chip} title="Temperature">
              <option value="">temp?</option>
              {TEMPERATURES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <select value={plan.next_action} onChange={e => set({ next_action: e.target.value })} disabled={busy} className={chip} title="What happens when you send">
            {nextActionOptions(kind).map(a => <option key={a} value={a}>{NEXT_ACTION_LABELS[a] ?? a}</option>)}
          </select>
          {plan.reason && (
            <span className="text-[11px] text-zinc-500 truncate max-w-full" title={plan.reason}>{plan.reason}</span>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-zinc-600">{busy ? "Reading the conversation…" : p.error ? "" : "No plan yet."}</div>
      )}

      {p.error && <div className="mt-1 text-[11px] text-red-300">{p.error}</div>}

      {open && (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            ref={inputRef}
            value={why}
            onChange={e => setWhy(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submitWhy() }}
            placeholder="What's off? One sentence."
            autoFocus
            className="flex-1 min-w-0 bg-zinc-900 border border-amber-900/60 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-600"
            style={{ fontSize: 16 }}
          />
          {canListen && (
            <button onClick={toggleMic} className={`p-2 rounded border ${listening ? "border-red-700 text-red-300" : "border-zinc-800 text-zinc-400 hover:text-zinc-200"}`} title={listening ? "Stop" : "Speak"}>
              {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          )}
          <button onClick={submitWhy} disabled={!why.trim()} className="px-3 py-2 min-h-[40px] rounded bg-amber-700 hover:bg-amber-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium">
            Redraft
          </button>
          <button onClick={() => { setOpen(false); setWhy("") }} className="p-2 text-zinc-500 hover:text-zinc-300" title="Cancel">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}
