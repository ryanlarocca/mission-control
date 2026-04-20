"use client"

import { useEffect, useState } from "react"
import { X, Loader2, Send, Save, Phone } from "lucide-react"

export interface TouchesSummary {
  count: number
  lastSentAt: string | null
  lastMessagePreview: string | null
}

interface InteractionEntry {
  timestamp: string
  modality: string
  message: string
  action: string
}

export interface ContactDetailContact {
  id: string
  sheetRow: number
  name: string
  category: string
  tier: string
  phone: string
  lastContacted: string
  notes: string
  hasNotes: boolean
}

interface Props {
  contact: ContactDetailContact
  onClose: () => void
  onSendToast: (msg: string) => void
  onNotesSaved: (sheetRow: number, notes: string) => void
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  })
}

export function ContactDetailModal({ contact, onClose, onSendToast, onNotesSaved }: Props) {
  const [history, setHistory] = useState<InteractionEntry[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [notes, setNotes] = useState(contact.notes)
  const [savingNotes, setSavingNotes] = useState(false)
  const [notesSaved, setNotesSaved] = useState(false)
  const [quickMessage, setQuickMessage] = useState("")

  // Fetch full history on mount
  useEffect(() => {
    setLoadingHistory(true)
    fetch(`/api/crms/touches?phone=${encodeURIComponent(contact.phone)}&full=1`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => setHistory(Array.isArray(d.history) ? d.history : []))
      .catch(() => setHistory([]))
      .finally(() => setLoadingHistory(false))
  }, [contact.phone])

  // Reset notes state when contact changes
  useEffect(() => {
    setNotes(contact.notes)
    setNotesSaved(false)
  }, [contact.id, contact.notes])

  // ESC to close + body scroll lock
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  async function handleSaveNotes() {
    if (savingNotes) return
    setSavingNotes(true)
    setNotesSaved(false)
    try {
      const res = await fetch("/api/crms/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheetRow: contact.sheetRow, notes }),
      })
      if (!res.ok) throw new Error()
      onNotesSaved(contact.sheetRow, notes)
      setNotesSaved(true)
      setTimeout(() => setNotesSaved(false), 2500)
    } catch {
      onSendToast(`Save notes failed for ${contact.name}`)
    } finally {
      setSavingNotes(false)
    }
  }

  function handleQuickSend() {
    const msg = quickMessage.trim()
    if (!msg) return
    setQuickMessage("")

    // Optimistic — fire send in background, toast on failure
    fetch("/api/crms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: contact.phone, message: msg }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`send ${res.status}`)
        fetch("/api/crms/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: contact.name, phone: contact.phone,
            sheetRow: contact.sheetRow, modality: "Reconnect", message: msg,
            action: "sent", tier: contact.tier, category: contact.category,
          }),
        }).catch(() => {})
        // Refresh history so the new message shows
        fetch(`/api/crms/touches?phone=${encodeURIComponent(contact.phone)}&full=1`, { cache: "no-store" })
          .then(r => r.json())
          .then(d => setHistory(Array.isArray(d.history) ? d.history : []))
          .catch(() => {})
      })
      .catch(err => {
        console.error(`Quick-send to ${contact.name} failed:`, err)
        onSendToast(`Send to ${contact.name} failed`)
      })
  }

  return (
    <div className="fixed inset-0 z-40 flex" onClick={onClose}>
      <div className="flex-1 bg-black/50" />
      <div
        onClick={e => e.stopPropagation()}
        className="w-full sm:w-[500px] h-full bg-zinc-950 border-l border-zinc-800 overflow-y-auto flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-100 truncate">{contact.name}</p>
            <p className="text-xs text-zinc-500">{contact.category} · Tier {contact.tier}</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-4 space-y-5">
          {/* Contact info */}
          <div>
            <p className="text-xs text-zinc-600 mb-2">Contact</p>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <span className="text-zinc-600">Phone</span>
              <span className="text-zinc-300 font-mono flex items-center gap-1.5">
                <Phone className="w-3 h-3 text-zinc-600" />
                {contact.phone}
              </span>
              <span className="text-zinc-600">Last contacted</span>
              <span className="text-zinc-300">{contact.lastContacted || "—"}</span>
              <span className="text-zinc-600">Sheet row</span>
              <span className="text-zinc-300 font-mono">{contact.sheetRow}</span>
            </div>
          </div>

          {/* Notes editor */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs text-zinc-600">Notes</p>
              <button
                onClick={handleSaveNotes}
                disabled={savingNotes || notes === contact.notes}
                className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
              >
                {savingNotes ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                {notesSaved ? "Saved" : "Save"}
              </button>
            </div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={5}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-200 leading-relaxed resize-none focus:outline-none focus:border-zinc-600"
              placeholder="Add a note..."
            />
          </div>

          {/* Quick send */}
          <div>
            <p className="text-xs text-zinc-600 mb-1.5">Quick send</p>
            <textarea
              value={quickMessage}
              onChange={e => setQuickMessage(e.target.value)}
              rows={3}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-200 leading-relaxed resize-none focus:outline-none focus:border-zinc-600"
              placeholder="Type a message and tap Send — fires immediately."
            />
            <div className="flex justify-end mt-1.5">
              <button
                onClick={handleQuickSend}
                disabled={!quickMessage.trim()}
                className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 hover:border-emerald-500/40 px-3 py-1.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send className="w-3.5 h-3.5" />
                Send
              </button>
            </div>
          </div>

          {/* Interaction history */}
          <div>
            <p className="text-xs text-zinc-600 mb-2">
              Interaction history {history.length > 0 && <span className="text-zinc-700">· {history.length}</span>}
            </p>
            {loadingHistory ? (
              <div className="flex items-center gap-2 py-4 text-xs text-zinc-600">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading history…
              </div>
            ) : history.length === 0 ? (
              <p className="text-xs text-zinc-600 italic py-2">No recorded outreach yet.</p>
            ) : (
              <div className="space-y-2">
                {history.map((h, idx) => (
                  <div key={idx} className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border leading-none ${
                        h.action === "sent"
                          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                          : "bg-zinc-700/20 text-zinc-500 border-zinc-700/30"
                      }`}>
                        {h.action || "—"}
                      </span>
                      {h.modality && <span className="text-[10px] text-zinc-500">{h.modality}</span>}
                      <span className="text-[10px] text-zinc-600 ml-auto">{formatDateTime(h.timestamp)}</span>
                    </div>
                    {h.message && (
                      <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">{h.message}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
