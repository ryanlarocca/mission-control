"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, Mic, MicOff, RefreshCw, Sparkles, ThumbsDown, X } from "lucide-react"
import {
  type Plan, type CoachTurn, MOMENT_LABELS, NEXT_ACTION_LABELS, TEMPERATURES, momentOptions, nextActionOptions, needsCoach,
} from "@/lib/reply-client"

// Reply Planner — the plan row + the draft controls that sit above every
// composer. Controlled: the parent owns the plan and the draft; this only
// renders the chips and reports changes.
//
// Two draft modes (briefs/BRIEF_COACHED_DRAFT_2026-10-15.md §E):
//  - Auto  — exactly what existed: a chip change → onPlanChange (the parent
//            regenerates); "Not right" → one sentence → onRegenerate(why).
//  - Coach — Ryan taps the mic (or types) and says the gist; "Draft from
//            this" → coach.onDraft. The read comes back muted above the
//            draft; the follow-up box posts another turn that carries the
//            previous gists + drafts. A chip change in Coach re-runs the coach
//            with the same gist.
// The nudge: an Auto draft with a bracketed placeholder ([OFFER PRICE]) gets
// "This one needs your number — Coach it".

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

export type DraftMode = "auto" | "coach"

export interface CoachControls {
  // The read the coach returned for the current draft (muted, above it).
  read: string | null
  // The draft as it stands in the composer (edited or not); a refinement
  // turn carries it back as the previous body.
  currentBody: string
  // Post a coach turn. Resolves true when a draft landed; the planner then
  // records the turn so the next follow-up sees it.
  onDraft: (args: { gist: string; turns: CoachTurn[]; plan: Plan | null }) => Promise<boolean>
}

type MicTarget = "why" | "gist" | "refine"

export function ReplyPlanner(p: {
  kind: "lead" | "relationship"
  plan: Plan | null
  busy: boolean
  error: string | null
  onPlanChange: (plan: Plan) => void
  onRegenerate: (why?: string) => void
  status?: string | null
  // Relationships queue: the tab's own intent/familiarity pickers are the
  // chips, so only the Not right / Redraft controls render.
  hideChips?: boolean
  // Coach mode. Every card that mounts the planner passes this.
  coach?: CoachControls
  // Identity of the contact this planner is drafting for. When it changes the
  // gist / refine / "not right" text and the coach session are cleared, so a
  // gist typed for one person never drafts the next (2026-10-27, Ryan: "I'd
  // prefer if the coach box doesn't keep text in there from other leads").
  // The Auto/Coach choice is kept. Mounts that remount per contact can omit it.
  contactKey?: string
}) {
  const { kind, plan, busy, coach } = p
  const [mode, setMode] = useState<DraftMode>("auto")
  const [open, setOpen] = useState(false)
  const [why, setWhy] = useState("")
  const [gist, setGist] = useState("")
  const [refine, setRefine] = useState("")
  // Coach session: the turns so far and the gist behind the current draft.
  const [turns, setTurns] = useState<CoachTurn[]>([])
  const [lastGist, setLastGist] = useState<string | null>(null)
  const [listening, setListening] = useState<MicTarget | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const gistRef = useRef<HTMLTextAreaElement | null>(null)
  const refineRef = useRef<HTMLInputElement | null>(null)
  const canListen = !!getSpeech()

  useEffect(() => () => { recRef.current?.stop() }, [])

  // New contact → fresh coach box (see contactKey above).
  const firstKeyRef = useRef(true)
  useEffect(() => {
    if (firstKeyRef.current) { firstKeyRef.current = false; return }
    recRef.current?.stop()
    setListening(null)
    setGist(""); setRefine(""); setWhy("")
    setTurns([]); setLastGist(null)
    setOpen(false)
  }, [p.contactKey])

  function toggleMic(target: MicTarget) {
    if (listening) { recRef.current?.stop(); setListening(null); if (listening === target) return }
    const Ctor = getSpeech()
    if (!Ctor) {
      if (target === "why") inputRef.current?.focus()
      else if (target === "gist") gistRef.current?.focus()
      else refineRef.current?.focus()
      return
    }
    const rec = new Ctor()
    rec.lang = "en-US"; rec.interimResults = false
    // The gist is a few sentences of speech; keep listening until Ryan stops.
    rec.continuous = target === "gist"
    rec.onresult = (e) => {
      const t = Array.from({ length: e.results.length }, (_, i) => e.results[i][0]?.transcript ?? "").join(" ").trim()
      if (!t) return
      const append = (prev: string) => (prev ? `${prev} ${t}` : t)
      if (target === "why") setWhy(append)
      else if (target === "gist") setGist(append)
      else setRefine(append)
    }
    rec.onend = () => setListening(null)
    rec.onerror = () => setListening(null)
    recRef.current = rec
    setListening(target)
    rec.start()
  }

  function submitWhy() {
    const text = why.trim()
    if (!text) return
    p.onRegenerate(text)
    setWhy("")
    setOpen(false)
  }

  async function submitGist() {
    if (!coach) return
    const text = gist.trim()
    if (!text || busy) return
    if (listening) { recRef.current?.stop(); setListening(null) }
    const ok = await coach.onDraft({ gist: text, turns: [], plan })
    if (ok) { setTurns([]); setLastGist(text) }
  }

  async function submitRefine() {
    if (!coach || !lastGist) return
    const text = refine.trim()
    if (!text || busy) return
    if (listening) { recRef.current?.stop(); setListening(null) }
    const nextTurns = [...turns, { gist: lastGist, body: coach.currentBody }]
    const ok = await coach.onDraft({ gist: text, turns: nextTurns, plan })
    if (ok) { setTurns(nextTurns); setLastGist(text); setRefine("") }
  }

  const set = (patch: Partial<Plan>) => {
    if (!plan) return
    const next: Plan = { ...plan, ...patch, source: "ryan" }
    // In Coach with a draft on the table, the chips re-run the coach, not Auto.
    if (mode === "coach" && coach && lastGist) {
      void coach.onDraft({ gist: lastGist, turns, plan: next })
      return
    }
    p.onPlanChange(next)
  }

  function switchMode(next: DraftMode) {
    if (next === mode) return
    if (listening) { recRef.current?.stop(); setListening(null) }
    setMode(next)
    setOpen(false)
    if (next === "coach") setTimeout(() => gistRef.current?.focus(), 0)
  }

  const chip = "bg-zinc-900 border border-zinc-800 rounded-full px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600 appearance-none"
  const micBtn = (target: MicTarget) => canListen ? (
    <button
      type="button"
      onClick={() => toggleMic(target)}
      className={`p-2 min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded border ${listening === target ? "border-red-700 text-red-300" : "border-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
      title={listening === target ? "Stop" : "Speak"}
    >
      {listening === target ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
    </button>
  ) : null
  const showNudge = !!coach && mode === "auto" && !busy && needsCoach(coach.currentBody)

  return (
    <div className="mb-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        {/* The label + Auto/Coach toggle never shrink; a long status note on
            the right (e.g. "checked: …") truncates instead. On a phone the
            old layout squeezed the toggle to a 1px border line. */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-xs text-zinc-500 whitespace-nowrap">{p.hideChips ? "Draft" : "Plan"}</div>
          {coach && (
            <div className="inline-flex shrink-0 rounded border border-zinc-800 overflow-hidden" role="tablist" aria-label="Draft mode">
              {(["auto", "coach"] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => switchMode(m)}
                  disabled={busy}
                  className={`px-3 min-h-[40px] text-xs font-medium transition-colors disabled:opacity-60 ${
                    mode === m ? "bg-violet-500/15 text-violet-200" : "bg-zinc-950 text-zinc-500 hover:text-zinc-300"
                  }`}
                  title={m === "auto" ? "Plan + draft from the conversation" : "Tell it the gist; it writes the message"}
                >
                  {m === "auto" ? "Auto" : "Coach"}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 min-w-0">
          {busy && (
            <span className="text-[11px] text-zinc-500 inline-flex items-center gap-1 whitespace-nowrap">
              <Loader2 className="w-3 h-3 animate-spin" /> {mode === "coach" ? "Coaching…" : plan ? "Drafting from plan…" : "Planning…"}
            </span>
          )}
          {!busy && p.status && <span className="text-[11px] text-zinc-600 truncate min-w-0 max-w-[220px]" title={p.status}>{p.status}</span>}
          {mode === "auto" && (
            <>
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
            </>
          )}
        </div>
      </div>

      {p.hideChips ? null : plan ? (
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
        <div className="text-[11px] text-zinc-600">
          {busy ? "Reading the conversation…" : p.error ? "" : mode === "coach" ? "The plan chips are stamped when the coach drafts." : "No plan yet."}
        </div>
      )}

      {p.error && <div className="mt-1 text-[11px] text-red-300">{p.error}</div>}

      {showNudge && (
        <button
          type="button"
          onClick={() => switchMode("coach")}
          className="mt-2 w-full text-left text-xs text-amber-200 bg-amber-950/40 border border-amber-900/60 rounded px-3 py-2 min-h-[40px] hover:bg-amber-950/60 inline-flex items-center gap-2"
          title="The draft left a placeholder for a number only you know. Tell the coach the gist and it writes the message."
        >
          <Sparkles className="w-3.5 h-3.5 shrink-0" /> This one needs your number — Coach it
        </button>
      )}

      {mode === "auto" && open && (
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
          {micBtn("why")}
          <button onClick={submitWhy} disabled={!why.trim()} className="px-3 py-2 min-h-[40px] rounded bg-amber-700 hover:bg-amber-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium">
            Redraft
          </button>
          <button onClick={() => { setOpen(false); setWhy("") }} className="p-2 text-zinc-500 hover:text-zinc-300" title="Cancel">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {mode === "coach" && coach && (
        <div className="mt-2 space-y-2">
          <div className="flex items-start gap-1.5">
            <textarea
              ref={gistRef}
              value={gist}
              onChange={e => setGist(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitGist() }}
              placeholder="Tap the mic or type the gist: the number, the reasoning, what you want to happen."
              rows={3}
              disabled={busy}
              className="flex-1 min-w-0 bg-zinc-900 border border-violet-900/60 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-violet-600 resize-y"
              style={{ fontSize: 16 }}
            />
            {micBtn("gist")}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-zinc-600 truncate">
              {listening === "gist" ? "Listening… tap the mic again to stop." : lastGist ? "Edit the draft below, or refine it." : "Opus reads the whole history plus your gist."}
            </span>
            <button
              type="button"
              onClick={() => void submitGist()}
              disabled={busy || !gist.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[40px] rounded bg-violet-700 hover:bg-violet-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium whitespace-nowrap"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              Draft from this
            </button>
          </div>

          {coach.read && !busy && (
            <div className="text-xs text-zinc-400 bg-zinc-900/60 border border-zinc-800/80 rounded px-3 py-2 whitespace-pre-wrap leading-relaxed" title="The coach's read of the situation. For you; never sent.">
              <span className="text-zinc-600">Read: </span>{coach.read}
            </div>
          )}

          {lastGist && (
            <div className="flex items-center gap-1.5">
              <input
                ref={refineRef}
                value={refine}
                onChange={e => setRefine(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void submitRefine() }}
                placeholder={`Refine: "shorter", "drop the comps", "make it 925"…`}
                disabled={busy}
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-violet-600"
                style={{ fontSize: 16 }}
              />
              {micBtn("refine")}
              <button
                type="button"
                onClick={() => void submitRefine()}
                disabled={busy || !refine.trim()}
                className="px-3 py-2 min-h-[40px] rounded bg-violet-800 hover:bg-violet-700 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium whitespace-nowrap"
              >
                Refine
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
