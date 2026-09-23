"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, Phone, X } from "lucide-react"

// Click-to-call for a Relationships contact, shared by the queue card and the
// detail modal. `useRelationshipCall` owns the call lifecycle (POST
// /api/crms/call, then poll the touch until the outcome or the transcript
// summary lands); `CallButton` + `CallStatusLine` render it.

export type CallContact = { id: string; name: string; phone: string; tier?: string; category?: string }

export type LiveCall = {
  contactId: string
  touchId: string | null
  phase: "dialing" | "transcribing" | "done" | "error"
  text: string
}

export function callNoteLine(summary: string): string {
  const stamp = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  return `[${stamp} call] ${summary}`
}

export function useRelationshipCall(opts: {
  // The call connected (contact answered) — counts as today's touch.
  onConnected?: (contactId: string) => void
  // The transcript summary was saved to the contact's notes server-side;
  // `line` is the dated note line to patch into local state.
  onSummary?: (contactId: string, summary: string, line: string) => void
}) {
  const [liveCall, setLiveCall] = useState<LiveCall | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  function stop() {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
  }
  useEffect(() => stop, [])

  async function startCall(contact: CallContact) {
    if (liveCall?.phase === "dialing") return
    stop()
    setLiveCall({ contactId: contact.id, touchId: null, phase: "dialing", text: "Ringing your cell…" })
    try {
      const res = await fetch("/api/crms/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: contact.id, phone: contact.phone, tier: contact.tier, category: contact.category }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
      const touchId: string = data.touchId
      setLiveCall({ contactId: contact.id, touchId, phase: "dialing", text: `Ringing your cell… answer to connect to ${contact.name}` })
      const started = Date.now()
      let connectedFired = false
      pollRef.current = setInterval(async () => {
        if (Date.now() - started > 20 * 60_000) { stop(); return }
        try {
          const r = await fetch(`/api/crms/call?touchId=${encodeURIComponent(touchId)}`, { cache: "no-store" })
          const d = await r.json()
          if (d.summary) {
            stop()
            setLiveCall({ contactId: contact.id, touchId, phase: "done", text: "Call summary saved to notes" })
            optsRef.current.onSummary?.(contact.id, d.summary, callNoteLine(d.summary))
          } else if (d.outcome) {
            stop()
            setLiveCall({ contactId: contact.id, touchId, phase: "done", text: d.outcome })
          } else if (d.status === "completed") {
            const mins = d.durationSec ? ` (${Math.floor(d.durationSec / 60)}:${String(d.durationSec % 60).padStart(2, "0")})` : ""
            setLiveCall({ contactId: contact.id, touchId, phase: "transcribing", text: `Call ended${mins} — transcribing, summary will land in notes…` })
            if (!connectedFired) { connectedFired = true; optsRef.current.onConnected?.(contact.id) }
          }
        } catch {}
      }, 5000)
    } catch (e) {
      setLiveCall({ contactId: contact.id, touchId: null, phase: "error", text: `Call failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  function dismiss() { stop(); setLiveCall(null) }
  return { liveCall, startCall, dismiss }
}

export function CallButton({ liveCall, contact, onClick, disabled, className }: {
  liveCall: LiveCall | null
  contact: CallContact | null
  onClick: () => void
  disabled?: boolean
  className?: string
}) {
  const dialing = liveCall?.phase === "dialing" && liveCall.contactId === contact?.id
  return (
    <button
      onClick={onClick}
      disabled={disabled || liveCall?.phase === "dialing" || !contact?.phone}
      title="Call them — rings your cell first, they see your number; recorded and summarized into notes"
      className={className ?? "flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 hover:border-emerald-500/50 px-3 py-1.5 rounded transition-colors disabled:opacity-50"}
    >
      {dialing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Phone className="w-3.5 h-3.5" />}
      Call
    </button>
  )
}

export function CallStatusLine({ liveCall, contactId, onDismiss, className }: {
  liveCall: LiveCall | null
  contactId: string | undefined
  onDismiss: () => void
  className?: string
}) {
  if (!liveCall || liveCall.contactId !== contactId) return null
  const busy = liveCall.phase === "dialing" || liveCall.phase === "transcribing"
  return (
    <div className={`${className ?? ""} text-xs flex items-center gap-2 ${
      liveCall.phase === "error" ? "text-red-400" : liveCall.phase === "done" ? "text-emerald-400" : "text-sky-300"
    }`}>
      {busy && <Loader2 className="w-3 h-3 animate-spin shrink-0" />}
      <span className="flex-1">{liveCall.text}</span>
      {liveCall.phase !== "dialing" && (
        <button onClick={onDismiss} className="text-zinc-500 hover:text-zinc-300"><X className="w-3 h-3" /></button>
      )}
    </div>
  )
}
