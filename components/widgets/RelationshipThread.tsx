"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import type { ThreadMessage } from "@/lib/relationship-messages"

// The contact's live text thread (chat.db + historic corpus via the sidecar),
// shared by the Relationships queue card and the contact detail modal.
// Auto-loads on mount, newest at the bottom, last 15 shown. A module-level
// cache keeps the queue card and the modal from re-fetching the same phone.

type ThreadState = { ok: boolean; total: number; messages: ThreadMessage[] }
const cache = new Map<string, ThreadState>()

function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (!Number.isFinite(days) || days < 0) return ""
  if (days === 0) return "today"
  return `${days}d ago`
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function RelationshipThread({ phone }: { phone: string }) {
  const [thread, setThread] = useState<ThreadState | null>(cache.get(phone) ?? null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const cached = cache.get(phone)
    if (cached) { setThread(cached); return }
    setThread(null)
    if (!phone) return
    fetch(`/api/crms/messages?phone=${encodeURIComponent(phone)}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        const next: ThreadState = { ok: d.ok !== false, total: d.total ?? (d.messages ?? []).length, messages: d.messages ?? [] }
        if (next.ok) cache.set(phone, next)
        if (alive) setThread(next)
      })
      .catch(() => { if (alive) setThread({ ok: false, total: 0, messages: [] }) })
    return () => { alive = false }
  }, [phone])

  const len = thread?.messages.length ?? 0
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }) }, [phone, len])

  return (
    <div>
      <p className="text-xs text-zinc-600 mb-1 flex items-center gap-1.5">
        Messages
        {thread === null && <Loader2 className="w-3 h-3 animate-spin" />}
        {thread && thread.ok && len > 0 && (
          <span className="text-zinc-700">
            · {thread.total > len ? `last ${len} of ${thread.total}` : len} · last text {daysAgo(thread.messages[len - 1].at) || "today"}
          </span>
        )}
      </p>
      {thread && !thread.ok && (
        <p className="text-xs text-zinc-600 italic">Message history unavailable (Mac mini offline)</p>
      )}
      {thread && thread.ok && len === 0 && (
        <p className="text-xs text-zinc-600 italic">No texts with this number</p>
      )}
      {thread && thread.ok && len > 0 && (
        <div className="max-h-64 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/40 p-2 space-y-1.5">
          {thread.messages.map((m, i) => {
            const prev = thread.messages[i - 1]
            const showDay = !prev || prev.at.slice(0, 10) !== m.at.slice(0, 10)
            return (
              <div key={i}>
                {showDay && <p className="text-[10px] text-zinc-600 text-center my-1">{dayLabel(m.at)}</p>}
                <div className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
                  <p className={`max-w-[80%] text-xs leading-snug px-2.5 py-1.5 rounded-lg whitespace-pre-wrap break-words ${
                    m.fromMe ? "bg-blue-500/15 text-blue-100" : "bg-zinc-800 text-zinc-200"
                  }`}>
                    {m.text}
                  </p>
                </div>
              </div>
            )
          })}
          <div ref={endRef} />
        </div>
      )}
    </div>
  )
}
