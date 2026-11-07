"use client"

import { useCallback, useEffect, useState } from "react"
import { FileText, Loader2, RefreshCw, X } from "lucide-react"
import type { CallScript } from "@/lib/coach/script"

// The pre-call script on a call card (Sales Coach, 2026-11-02). Opens when
// Ryan taps Call (the card is pinned while the call runs) or taps Script
// before dialing. Two blocks in phone-readable type: the voicemail he'll
// leave if nobody answers, and the live opener + questions + likely
// objection if they do. Rendered by the Follow Ups and Leads cards; the
// script comes from POST /api/coach/script (Sonnet since 2026-11-07, lib/coach/script.ts).
//
// `leadId` is the outbound call row when the panel opened from a Call —
// the API saves the script on that row so the post-call rater can see it.
// `callerId` is the number the lead sees; the voicemail says it twice.

export function CallScriptPanel({
  phone, leadId, callerId, onClose,
}: {
  phone: string
  leadId: string | null
  callerId: string | null
  onClose: () => void
}) {
  const [script, setScript] = useState<CallScript | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // force=true (the refresh button) skips the server's day-old cache.
  const load = useCallback(async (force = false) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch("/api/coach/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, leadId, callerId, force }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.script) throw new Error(body.error || `HTTP ${res.status}`)
      setScript(body.script as CallScript)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [phone, leadId, callerId])

  // Generate once per open. A Call after a pre-dial Script re-runs with the
  // call row + caller ID so the saved copy matches what's on screen.
  useEffect(() => { void load() }, [load])

  return (
    <div className="px-3 py-3 border-t border-emerald-900/60 bg-zinc-950">
      <div className="flex items-center gap-2 text-xs mb-2">
        <FileText className="w-3.5 h-3.5 text-emerald-400" />
        <span className="text-zinc-300 font-medium">Script</span>
        {script?.numberToSay && <span className="text-zinc-500">· say {script.numberToSay}</span>}
        <button
          onClick={() => void load(true)}
          disabled={loading}
          title="Write it again"
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 min-h-[30px] rounded border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <button
          onClick={onClose}
          title="Hide the script"
          className="inline-flex items-center px-2 py-1 min-h-[30px] rounded border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {loading && !script && (
        <div className="flex items-center gap-2 text-sm text-zinc-400 py-3">
          <Loader2 className="w-4 h-4 animate-spin" /> Writing the script from their history…
        </div>
      )}
      {err && !loading && (
        <div className="text-sm text-red-300 py-2">
          {err}{" "}
          <button onClick={() => void load()} className="underline underline-offset-2 text-red-200">Try again</button>
        </div>
      )}

      {script && (
        <div className={`space-y-4 ${loading ? "opacity-50" : ""}`}>
          {script.hook && (
            <p className="text-sm text-amber-200/90 italic leading-relaxed">{script.hook}</p>
          )}

          <section>
            <div className="text-[11px] uppercase tracking-wider text-emerald-400 font-semibold mb-1">Voicemail</div>
            <div className="space-y-1.5">
              {script.voicemail.map((line, i) => (
                <p key={i} className="text-base leading-relaxed text-zinc-100">{line}</p>
              ))}
            </div>
          </section>

          <section>
            <div className="text-[11px] uppercase tracking-wider text-sky-400 font-semibold mb-1">If they pick up</div>
            <p className="text-base leading-relaxed text-zinc-100">{script.live.opener}</p>
            {script.live.questions.length > 0 && (
              <ol className="mt-2 space-y-1.5 list-decimal list-inside">
                {script.live.questions.map((q, i) => (
                  <li key={i} className="text-base leading-relaxed text-zinc-200">{q}</li>
                ))}
              </ol>
            )}
            {script.live.objection && (
              <div className="mt-3 rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                <p className="text-sm text-zinc-400">If they say: <span className="text-zinc-200">“{script.live.objection}”</span></p>
                <p className="mt-1 text-base leading-relaxed text-zinc-100">{script.live.answer}</p>
              </div>
            )}
          </section>

          {script.watchOut && (
            <p className="text-sm text-zinc-400"><span className="text-amber-300">Watch out:</span> {script.watchOut}</p>
          )}
        </div>
      )}
    </div>
  )
}
