"use client"

import { useState, useEffect, useRef, Component, ReactNode } from "react"
import {
  Send, RefreshCw, SkipForward, Phone, Loader2,
  UserCheck, User, Wrench, TrendingUp, Home, Building2,
  MessageSquare, AlertTriangle,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

// ══════════════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════════════

type Category = "Agent" | "Personal" | "Vendor" | "Investor" | "Seller" | "Property Manager"
type Tier     = "A" | "B" | "C" | "D" | "E"
type Modality = "Familiar" | "Reconnect" | "ColdReintro"

const MODALITY_LABEL: Record<Modality, string> = {
  Familiar:    "Familiar",
  Reconnect:   "Reconnect",
  ColdReintro: "Cold Reintro",
}
const MODALITIES: Modality[] = ["Familiar", "Reconnect", "ColdReintro"]
const TIERS: Tier[] = ["A", "B", "C", "D", "E"]

function coerceModality(m: unknown): Modality {
  if (m === "Familiar" || m === "Reconnect" || m === "ColdReintro") return m
  if (m === "Cold Reintro") return "ColdReintro"
  if (m === "Casual") return "Familiar"
  if (m === "Direct" || m === "Collaborative") return "Reconnect"
  if (m === "Check-in") return "ColdReintro"
  return "Reconnect"
}

interface CRMSContact {
  id:            string
  sheetRow:      number
  name:          string
  category:      Category
  tier:          Tier
  phone:         string
  lastContact:   string
  lastContacted: string
  daysOverdue:   number
  status:        "due" | "overdue"
  notes:         string
  hasNotes:      boolean
  notesStale:    boolean
}

// ══════════════════════════════════════════════════════════════════════════════
// STYLE MAPS
// ══════════════════════════════════════════════════════════════════════════════

const tierStyle: Record<string, string> = {
  A: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  B: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  C: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  D: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  E: "bg-zinc-700/20 text-zinc-600 border-zinc-700/30",
}

const categoryColor: Record<string, string> = {
  Agent:              "text-violet-400",
  Personal:           "text-pink-400",
  Vendor:             "text-orange-400",
  Investor:           "text-blue-400",
  Seller:             "text-emerald-400",
  "Property Manager": "text-teal-400",
}

const categoryIcon: Record<string, LucideIcon> = {
  Agent:              UserCheck,
  Personal:           User,
  Vendor:             Wrench,
  Investor:           TrendingUp,
  Seller:             Home,
  "Property Manager": Building2,
}

const modalityActive: Record<Modality, string> = {
  Familiar:    "bg-emerald-500/10 text-emerald-400 border-emerald-500/40",
  Reconnect:   "bg-blue-500/10 text-blue-400 border-blue-500/40",
  ColdReintro: "bg-amber-500/10 text-amber-400 border-amber-500/40",
}

// ══════════════════════════════════════════════════════════════════════════════
// SESSION STORAGE (progress survives refresh)
// ══════════════════════════════════════════════════════════════════════════════

const sessionKey = () => `crms-session-${new Date().toISOString().slice(0, 10)}`

function loadSession(): { sent: string[]; skipped: string[] } {
  try {
    if (typeof window === "undefined") return { sent: [], skipped: [] }
    const raw = sessionStorage.getItem(sessionKey())
    if (!raw) return { sent: [], skipped: [] }
    const parsed = JSON.parse(raw)
    return { sent: parsed.sent || [], skipped: parsed.skipped || [] }
  } catch { return { sent: [], skipped: [] } }
}

function saveSession(sent: Set<string>, skipped: Set<string>) {
  try {
    if (typeof window === "undefined") return
    sessionStorage.setItem(sessionKey(), JSON.stringify({
      sent: Array.from(sent),
      skipped: Array.from(skipped),
    }))
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// ERROR BOUNDARY
// ══════════════════════════════════════════════════════════════════════════════

class CRMSErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) { console.error("CRMSTab error:", error) }
  render() {
    if (this.state.hasError) {
      return (
        <div className="text-center py-16 space-y-3">
          <AlertTriangle className="w-6 h-6 text-amber-400 mx-auto" />
          <p className="text-sm text-zinc-300">Something went wrong</p>
          <button
            onClick={() => window.location.reload()}
            className="text-xs text-zinc-400 hover:text-zinc-200 underline"
          >
            Click to reload — your progress is saved
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ══════════════════════════════════════════════════════════════════════════════

const SEND_TIMEOUT_MS = 30000
const GENERATE_DEBOUNCE_MS = 300

export function CRMSTab() {
  return (
    <CRMSErrorBoundary>
      <CRMSTabInner />
    </CRMSErrorBoundary>
  )
}

function CRMSTabInner() {
  // ── Data state ──
  const [contacts, setContacts]               = useState<CRMSContact[]>([])
  const [total, setTotal]                     = useState(0)
  const [loadingContacts, setLoadingContacts] = useState(true)
  const [contactsError, setContactsError]     = useState<string | null>(null)

  // ── Session state ──
  const [selectedId, setSelectedId]   = useState<string>("")
  const [modality, setModality]       = useState<Modality>("Reconnect")
  const [sent, setSent]               = useState<Set<string>>(() => new Set(loadSession().sent))
  const [skipped, setSkipped]         = useState<Set<string>>(() => new Set(loadSession().skipped))
  const [mobileView, setMobileView]   = useState<"list" | "compose">("list")
  const [sendError, setSendError]     = useState<string | null>(null)

  // ── Message state ──
  const [generatedMessages, setGeneratedMessages] = useState<Record<string, string>>({})
  const [editedMessages, setEditedMessages]       = useState<Record<string, string>>({})
  const [generatingFor, setGeneratingFor]         = useState<string | null>(null)
  const [enrichingFor, setEnrichingFor]           = useState<string | null>(null)
  const [tierChangingFor, setTierChangingFor]     = useState<string | null>(null)
  const [actionPending, setActionPending]         = useState(false)

  // ── Refs for debounce + abort ──
  const generateAbortRef = useRef<AbortController | null>(null)
  const selectDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Persist session progress on change
  useEffect(() => { saveSession(sent, skipped) }, [sent, skipped])

  // Fetch contacts on mount
  useEffect(() => {
    fetchContacts()
    return () => {
      if (selectDebounceRef.current) clearTimeout(selectDebounceRef.current)
      generateAbortRef.current?.abort()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchContacts() {
    setLoadingContacts(true)
    setContactsError(null)
    try {
      const res = await fetch("/api/crms/contacts")
      if (!res.ok) throw new Error()
      const data = await res.json()
      const loaded: CRMSContact[] = data.contacts || []
      setContacts(loaded)
      setTotal(data.total || 0)
      // Auto-select first contact not already sent/skipped
      const firstDue = loaded.find(c => !sent.has(c.id) && !skipped.has(c.id))
      if (firstDue) {
        setSelectedId(firstDue.id)
        generate(firstDue, modality)
      }
    } catch {
      setContactsError("Could not load contacts — check Sheets API / service account.")
    } finally {
      setLoadingContacts(false)
    }
  }

  // ── Core generate — aborts any prior in-flight request ──
  async function generate(contact: CRMSContact, mod: Modality, force = false) {
    const msgKey = `${contact.id}::${mod}`
    if (!force && (editedMessages[msgKey] || generatedMessages[msgKey])) return

    generateAbortRef.current?.abort()
    const controller = new AbortController()
    generateAbortRef.current = controller

    setGeneratingFor(contact.id)
    try {
      const res = await fetch("/api/crms/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:     contact.name,
          phone:    contact.phone,
          tier:     contact.tier,
          category: contact.category,
          modality: mod,
          notes:    contact.notes,
          hasNotes: contact.hasNotes,
        }),
        signal: controller.signal,
      })
      const data = await res.json()
      if (data.message) {
        setGeneratedMessages(prev => ({ ...prev, [msgKey]: data.message }))
      }
    } catch {}
    finally {
      if (generateAbortRef.current === controller) {
        setGeneratingFor(null)
      }
    }
  }

  // ── Contact selection — debounced to avoid hammering on rapid clicks ──
  function handleSelectContact(contact: CRMSContact) {
    setSelectedId(contact.id)
    setMobileView("compose")
    setSendError(null)

    if (selectDebounceRef.current) clearTimeout(selectDebounceRef.current)
    selectDebounceRef.current = setTimeout(async () => {
      let mod: Modality = modality
      try {
        const res = await fetch(`/api/crms/generate?phone=${encodeURIComponent(contact.phone)}`)
        const data = await res.json()
        if (data.preferred_modality) {
          mod = coerceModality(data.preferred_modality)
          setModality(mod)
        }
      } catch {}
      generate(contact, mod)
    }, GENERATE_DEBOUNCE_MS)
  }

  function handleModalityChange(m: Modality) {
    setModality(m)
    if (selectedContact) generate(selectedContact, m)
  }

  async function regenerate() {
    if (!selectedContact || generatingFor) return
    const msgKey = `${selectedContact.id}::${modality}`
    setEditedMessages(prev => { const n = { ...prev }; delete n[msgKey]; return n })
    setGeneratedMessages(prev => { const n = { ...prev }; delete n[msgKey]; return n })
    await generate(selectedContact, modality, true)
  }

  // ── Tier change: PATCH sheet + update local state (or drop from queue on E) ──
  async function handleTierChange(newTier: Tier) {
    if (!selectedContact || tierChangingFor) return
    if (selectedContact.tier === newTier) return
    setTierChangingFor(selectedContact.id)
    try {
      const res = await fetch("/api/crms/tier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheetRow: selectedContact.sheetRow, tier: newTier }),
      })
      if (!res.ok) throw new Error()

      if (newTier === "E") {
        const dropped = selectedContact.id
        setContacts(prev => prev.filter(c => c.id !== dropped))
        advanceSelection(dropped)
      } else {
        setContacts(prev => prev.map(c =>
          c.id === selectedContact.id ? { ...c, tier: newTier } : c
        ))
      }
    } catch {
      setSendError("Tier update failed — try again")
    } finally {
      setTierChangingFor(null)
    }
  }

  // ── Send: await the critical path; fire-and-forget the rest ──
  async function handleSend() {
    if (!selectedContact || actionPending) return
    const message = getMessage(selectedContact)
    if (!message) return

    setActionPending(true)
    setSendError(null)

    const contact = selectedContact
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)

    try {
      const res = await fetch("/api/crms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: contact.phone, message }),
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!res.ok) throw new Error(`send ${res.status}`)

      fetch("/api/crms/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: contact.name, phone: contact.phone,
          sheetRow: contact.sheetRow, modality, message,
          action: "sent", tier: contact.tier, category: contact.category,
        }),
      }).catch(() => {})

      fetch("/api/crms/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: contact.name, phone: contact.phone,
          tier: contact.tier, category: contact.category,
          modality, notes: contact.notes, hasNotes: contact.hasNotes,
          savePreference: true,
        }),
      }).catch(() => {})

      setSent(prev => new Set(prev).add(contact.id))
      advanceSelection(contact.id)
    } catch (err) {
      clearTimeout(timeout)
      const aborted = (err as Error)?.name === "AbortError"
      setSendError(aborted ? "Send timed out — try again or skip" : "Send failed — try again or skip")
    } finally {
      setActionPending(false)
    }
  }

  async function handleSkip() {
    if (!selectedContact || actionPending) return
    const contact = selectedContact
    setActionPending(true)
    try {
      await fetch("/api/crms/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: contact.name, phone: contact.phone,
          sheetRow: contact.sheetRow, modality, message: "",
          action: "skipped", tier: contact.tier, category: contact.category,
        }),
      })
    } catch {}
    setSkipped(prev => new Set(prev).add(contact.id))
    advanceSelection(contact.id)
    setActionPending(false)
  }

  async function handleEnrich() {
    if (!selectedContact || enrichingFor) return
    setEnrichingFor(selectedContact.id)
    try {
      const res = await fetch("/api/crms/enrich-one", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: selectedContact.phone }),
      })
      const data = await res.json()
      if (data.enriched && data.note) {
        setContacts(prev => prev.map(c =>
          c.id === selectedContact.id
            ? { ...c, notes: data.note, hasNotes: true, notesStale: false }
            : c
        ))
        const msgKey = `${selectedContact.id}::${modality}`
        setGeneratedMessages(prev => { const n = { ...prev }; delete n[msgKey]; return n })
        setEditedMessages(prev => { const n = { ...prev }; delete n[msgKey]; return n })
        setEnrichingFor(null)
        const updated = { ...selectedContact, notes: data.note, hasNotes: true, notesStale: false }
        await generate(updated, modality)
        return
      }
    } catch {}
    setEnrichingFor(null)
  }

  function advanceSelection(excludeId: string) {
    const remaining = contacts.filter(c =>
      c.id !== excludeId && !sent.has(c.id) && !skipped.has(c.id)
    )
    const next = remaining[0]
    if (!next) { setSelectedId(""); setMobileView("list"); return }
    setSelectedId(next.id)
    generate(next, modality)
  }

  function getMessage(contact: CRMSContact): string {
    const msgKey = `${contact.id}::${modality}`
    return editedMessages[msgKey] ?? generatedMessages[msgKey] ?? ""
  }

  function handleEdit(value: string) {
    if (!selectedContact) return
    setEditedMessages(prev => ({ ...prev, [`${selectedContact.id}::${modality}`]: value }))
  }

  // ── Derived ──
  const dueContacts     = contacts.filter(c => !sent.has(c.id) && !skipped.has(c.id))
  const selectedContact = dueContacts.find(c => c.id === selectedId) ?? null

  const isGenerating   = generatingFor === selectedContact?.id
  const isEnriching    = enrichingFor  === selectedContact?.id
  const isChangingTier = tierChangingFor === selectedContact?.id
  const currentMessage = selectedContact ? getMessage(selectedContact) : ""

  if (loadingContacts) {
    return (
      <div className="flex items-center justify-center py-16 gap-2">
        <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
        <span className="text-sm text-zinc-500">Loading contacts…</span>
      </div>
    )
  }

  if (contactsError) {
    return (
      <div className="text-center py-16 space-y-2">
        <p className="text-sm text-red-400">{contactsError}</p>
        <button onClick={fetchContacts} className="text-xs text-zinc-400 hover:text-zinc-200 underline">Retry</button>
      </div>
    )
  }

  return (
    <div className="space-y-3">

      {/* Header bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="bg-amber-500/10 border border-amber-500/20 rounded px-3 py-1.5">
          <p className="text-xs text-amber-400 font-medium">{dueContacts.length} contacts due now</p>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded px-3 py-1.5">
          <p className="text-xs text-red-400 font-medium">{total} total overdue</p>
        </div>
        {sent.size > 0 && (
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-1.5">
            <p className="text-xs text-emerald-400 font-medium">{sent.size} sent this session</p>
          </div>
        )}
        <button onClick={fetchContacts} className="text-zinc-600 hover:text-zinc-400 transition-colors ml-auto" title="Refresh">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {dueContacts.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-sm text-zinc-500">All caught up — no contacts due today</p>
        </div>
      ) : (
        <div className="sm:flex sm:gap-3">

          {/* Left panel: contact list */}
          <div className={`sm:block sm:w-52 sm:shrink-0 sm:space-y-1 sm:max-h-[520px] sm:overflow-y-auto ${mobileView === "compose" ? "hidden" : "block space-y-1"}`}>
            {dueContacts.map(contact => {
              const Icon     = categoryIcon[contact.category] ?? User
              const isActive = contact.id === selectedContact?.id
              return (
                <button
                  key={contact.id}
                  onClick={() => handleSelectContact(contact)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                    isActive
                      ? "bg-zinc-800 border-zinc-600"
                      : "bg-zinc-900 border-zinc-800 hover:border-zinc-700"
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={`text-xs font-bold px-1 py-0.5 rounded border leading-none ${tierStyle[contact.tier] ?? tierStyle.C}`}>
                      {contact.tier}
                    </span>
                    <Icon className={`w-3 h-3 shrink-0 ${categoryColor[contact.category] ?? "text-zinc-400"}`} />
                    {contact.status === "overdue" && (
                      <span className="ml-auto w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" title="Overdue" />
                    )}
                    {contact.notesStale && (
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 ml-auto" title="Notes stale" />
                    )}
                  </div>
                  <p className="text-xs font-medium text-zinc-200 truncate leading-snug">{contact.name}</p>
                  <p className={`text-xs truncate leading-snug ${categoryColor[contact.category] ?? "text-zinc-400"}`}>
                    {contact.category}
                  </p>
                  <p className="text-xs text-zinc-600 mt-0.5">{contact.lastContact}</p>
                </button>
              )
            })}
          </div>

          {/* Right panel: composer */}
          {selectedContact ? (
            <div className={`sm:flex flex-1 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden flex-col min-w-0 ${mobileView === "list" ? "hidden" : "flex"}`}>

              {/* Contact header */}
              <div className="px-4 py-3 border-b border-zinc-800">
                <button
                  onClick={() => setMobileView("list")}
                  className="sm:hidden flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 mb-2"
                >
                  ← All contacts
                </button>
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <p className="text-sm font-semibold text-zinc-100">{selectedContact.name}</p>
                  <span className={`text-xs font-medium ${categoryColor[selectedContact.category] ?? "text-zinc-400"}`}>
                    {selectedContact.category}
                  </span>
                  <span className={`ml-auto text-xs px-1.5 py-0.5 rounded border leading-none ${
                    selectedContact.status === "overdue"
                      ? "bg-red-500/20 text-red-400 border-red-500/30"
                      : "bg-amber-500/20 text-amber-400 border-amber-500/30"
                  }`}>
                    {selectedContact.status === "overdue" ? `${selectedContact.daysOverdue}d overdue` : "due today"}
                  </span>
                </div>

                {/* Inline tier selector */}
                <div className="flex items-center gap-1 mb-2">
                  <span className="text-xs text-zinc-500 mr-1">Tier:</span>
                  {TIERS.map(t => (
                    <button
                      key={t}
                      onClick={() => handleTierChange(t)}
                      disabled={isChangingTier}
                      className={`text-xs font-bold px-1.5 py-0.5 rounded border leading-none transition-colors disabled:opacity-50 ${
                        selectedContact.tier === t
                          ? tierStyle[t]
                          : "bg-transparent text-zinc-600 border-zinc-800 hover:text-zinc-300 hover:border-zinc-600"
                      }`}
                      title={t === "E" ? "Non-recurring (no cadence)" : t === "D" ? "Yearly cadence" : `Tier ${t}`}
                    >
                      {t}
                    </button>
                  ))}
                  {isChangingTier && <Loader2 className="w-3 h-3 text-zinc-500 animate-spin ml-1" />}
                </div>

                {selectedContact.hasNotes ? (
                  <div className="flex items-start gap-2">
                    <p className="text-xs text-zinc-500 leading-relaxed flex-1">{selectedContact.notes}</p>
                    {selectedContact.notesStale && (
                      <button
                        onClick={handleEnrich}
                        disabled={!!isEnriching}
                        className="text-xs text-amber-400 hover:text-amber-300 shrink-0 flex items-center gap-1 disabled:opacity-50"
                      >
                        {isEnriching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                        Re-enrich
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-zinc-600 italic">No notes</p>
                    <button
                      onClick={handleEnrich}
                      disabled={!!isEnriching}
                      className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 disabled:opacity-50"
                    >
                      {isEnriching ? <Loader2 className="w-3 h-3 animate-spin" /> : <MessageSquare className="w-3 h-3" />}
                      Enrich
                    </button>
                  </div>
                )}
              </div>

              {/* Modality selector */}
              <div className="px-4 py-2.5 border-b border-zinc-800">
                <div className="flex gap-2 flex-wrap">
                  {MODALITIES.map(m => (
                    <button
                      key={m}
                      onClick={() => handleModalityChange(m)}
                      className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                        modality === m
                          ? modalityActive[m]
                          : "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
                      }`}
                    >
                      {MODALITY_LABEL[m]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Message */}
              <div className="px-4 py-3">
                {isGenerating ? (
                  <div className="flex items-center justify-center gap-2 bg-zinc-800 border border-zinc-700 rounded h-20">
                    <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
                    <span className="text-xs text-zinc-500">Generating…</span>
                  </div>
                ) : (
                  <textarea
                    value={currentMessage}
                    onChange={e => handleEdit(e.target.value)}
                    rows={3}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2.5 text-xs text-zinc-200 leading-relaxed resize-none focus:outline-none focus:border-zinc-500 transition-colors"
                  />
                )}
                <div className="flex items-center gap-1.5 mt-1.5">
                  <Phone className="w-3 h-3 text-zinc-600" />
                  <span className="text-xs text-zinc-600 font-mono">{selectedContact.phone}</span>
                </div>
                {sendError && (
                  <p className="text-xs text-red-400 mt-1.5 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    {sendError}
                  </p>
                )}
              </div>

              {/* Action buttons */}
              <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-2">
                <button
                  onClick={handleSend}
                  disabled={actionPending || isGenerating || !currentMessage}
                  className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 hover:border-emerald-500/40 px-3 py-1.5 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {actionPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  Send
                </button>
                <button
                  onClick={regenerate}
                  disabled={!!generatingFor}
                  className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 bg-blue-500/10 border border-blue-500/20 hover:border-blue-500/40 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isGenerating ? "animate-spin" : ""}`} />
                  Regenerate
                </button>
                <button
                  onClick={handleSkip}
                  disabled={actionPending}
                  className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 px-3 py-1.5 rounded transition-colors ml-auto disabled:opacity-50"
                >
                  <SkipForward className="w-3.5 h-3.5" />
                  Skip
                </button>
              </div>

            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-zinc-600">Select a contact</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
