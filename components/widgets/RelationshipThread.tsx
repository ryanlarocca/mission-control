"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, Mail } from "lucide-react"
import type { ThreadMessage } from "@/lib/relationship-messages"

// The contact's live conversation, shared by the Relationships queue card and
// the contact detail modal. Texts come from chat.db via the sidecar; emails
// (2026-10-09) come from relationship_touches rows with modality "email" —
// an agent's campaign reply ("inbound") and anything sent from the card's
// Email button ("sent"). Merged by time, newest at the bottom, last 15 shown.
// A module-level cache keeps the queue card and the modal from re-fetching
// the same phone.

type ThreadEntry = ThreadMessage & { kind: "text" | "email"; subject?: string }
type ThreadState = { textsOk: boolean; total: number; messages: ThreadEntry[] }
const cache = new Map<string, ThreadState>()
const SHOWN = 15
const EMAIL_PREVIEW_CHARS = 420

function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (!Number.isFinite(days) || days < 0) return ""
  if (days === 0) return "today"
  return `${days}d ago`
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// Stored email touches are "<subject>\n<body>" (lib/relationshipEmail.ts).
function splitEmail(message: string): { subject: string; body: string } {
  const nl = message.indexOf("\n")
  if (nl < 0) return { subject: message.trim(), body: "" }
  return { subject: message.slice(0, nl).trim(), body: message.slice(nl + 1).trim() }
}

async function loadTexts(phone: string): Promise<{ ok: boolean; total: number; messages: ThreadMessage[] }> {
  try {
    const d = await fetch(`/api/crms/messages?phone=${encodeURIComponent(phone)}`, { cache: "no-store" }).then(r => r.json())
    const messages: ThreadMessage[] = d.messages ?? []
    return { ok: d.ok !== false, total: d.total ?? messages.length, messages }
  } catch {
    return { ok: false, total: 0, messages: [] }
  }
}

async function loadEmails(phone: string): Promise<ThreadEntry[]> {
  try {
    const d = await fetch(`/api/crms/touches?phone=${encodeURIComponent(phone)}&full=1`, { cache: "no-store" }).then(r => r.json())
    const history: { timestamp: string; modality: string; action: string; message: string }[] = Array.isArray(d.history) ? d.history : []
    return history
      .filter(h => h.modality === "email" && h.message)
      .map(h => {
        const { subject, body } = splitEmail(h.message)
        return { kind: "email" as const, at: h.timestamp, fromMe: h.action !== "inbound", subject, text: body || subject }
      })
  } catch {
    return []
  }
}

function EmailBubble({ m }: { m: ThreadEntry }) {
  const [expanded, setExpanded] = useState(false)
  const long = m.text.length > EMAIL_PREVIEW_CHARS
  const shown = expanded || !long ? m.text : `${m.text.slice(0, EMAIL_PREVIEW_CHARS).trimEnd()}…`
  return (
    <div className={`max-w-[88%] text-xs leading-snug px-2.5 py-1.5 rounded-lg ${m.fromMe ? "bg-blue-500/15 text-blue-100" : "bg-zinc-800 text-zinc-200"}`}>
      <p className={`flex items-center gap-1 text-[10px] mb-0.5 ${m.fromMe ? "text-blue-300/70" : "text-zinc-500"}`}>
        <Mail className="w-3 h-3" /> email{m.subject ? <span className="font-medium truncate">· {m.subject}</span> : null}
      </p>
      <p className="whitespace-pre-wrap break-words">{shown}</p>
      {long && (
        <button type="button" onClick={() => setExpanded(e => !e)} className={`text-[10px] mt-1 underline underline-offset-2 ${m.fromMe ? "text-blue-300/80" : "text-zinc-400"}`}>
          {expanded ? "Show less" : "Show full email"}
        </button>
      )}
    </div>
  )
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
    Promise.all([loadTexts(phone), loadEmails(phone)]).then(([texts, emails]) => {
      const merged: ThreadEntry[] = [
        ...texts.messages.map(m => ({ ...m, kind: "text" as const })),
        ...emails,
      ].sort((a, b) => a.at.localeCompare(b.at))
      const next: ThreadState = {
        textsOk: texts.ok,
        total: Math.max(texts.total, texts.messages.length) + emails.length,
        messages: merged.slice(-SHOWN),
      }
      if (next.textsOk) cache.set(phone, next)
      if (alive) setThread(next)
    })
    return () => { alive = false }
  }, [phone])

  const len = thread?.messages.length ?? 0
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }) }, [phone, len])

  return (
    <div>
      <p className="text-xs text-zinc-600 mb-1 flex items-center gap-1.5">
        Messages
        {thread === null && <Loader2 className="w-3 h-3 animate-spin" />}
        {thread && len > 0 && (
          <span className="text-zinc-700">
            · {thread.total > len ? `last ${len} of ${thread.total}` : len} · last {thread.messages[len - 1].kind === "email" ? "email" : "text"} {daysAgo(thread.messages[len - 1].at) || "today"}
          </span>
        )}
      </p>
      {thread && !thread.textsOk && (
        <p className="text-xs text-zinc-600 italic">Text history unavailable (Mac mini offline)</p>
      )}
      {thread && thread.textsOk && len === 0 && (
        <p className="text-xs text-zinc-600 italic">No texts or emails with this contact</p>
      )}
      {thread && len > 0 && (
        <div className="max-h-64 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/40 p-2 space-y-1.5">
          {thread.messages.map((m, i) => {
            const prev = thread.messages[i - 1]
            const showDay = !prev || prev.at.slice(0, 10) !== m.at.slice(0, 10)
            return (
              <div key={i}>
                {showDay && <p className="text-[10px] text-zinc-600 text-center my-1">{dayLabel(m.at)}</p>}
                <div className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
                  {m.kind === "email" ? (
                    <EmailBubble m={m} />
                  ) : (
                    <p className={`max-w-[80%] text-xs leading-snug px-2.5 py-1.5 rounded-lg whitespace-pre-wrap break-words ${
                      m.fromMe ? "bg-blue-500/15 text-blue-100" : "bg-zinc-800 text-zinc-200"
                    }`}>
                      {m.text}
                    </p>
                  )}
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

/** Drop the cached thread for a phone so the next mount refetches (after a send). */
export function invalidateRelationshipThread(phone: string) {
  cache.delete(phone)
}
