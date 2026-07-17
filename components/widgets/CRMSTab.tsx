"use client"

import { useState, useEffect, useRef, useMemo, Component, ReactNode } from "react"
import {
  Send, RefreshCw, SkipForward, Phone, Loader2,
  UserCheck, User, Wrench, TrendingUp, Home, Building2,
  MessageSquare, AlertTriangle, CheckCircle2, Check, Search, X, Banknote,
  ListChecks, Undo2,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { ContactDetailModal } from "./ContactDetailModal"
import type { TouchesSummary } from "./ContactDetailModal"
import { CleanupMode } from "./CleanupMode"

// ══════════════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════════════

type ContactType = "Agent" | "Personal" | "Vendor" | "PM" | "Investor" | "PrivateMoney" | "Seller"
type Tier = "A" | "B" | "C" | "D" | "E"
type Modality =
  | "Familiar" | "Reconnect" | "ColdReintro"
  | "Portfolio" | "CatchUp" | "CheckIn" | "Referral"

const MODALITIES_BY_TYPE: Record<ContactType, Modality[]> = {
  Agent:    ["Familiar", "Reconnect", "ColdReintro"],
  Vendor:   ["Referral", "Familiar", "Reconnect", "ColdReintro"],
  Investor: ["Familiar", "Reconnect", "ColdReintro"],
  PrivateMoney: ["Familiar", "Reconnect", "ColdReintro"],
  Seller:   ["Familiar", "Reconnect", "ColdReintro"],
  PM:       ["Portfolio", "Reconnect", "ColdReintro"],
  Personal: ["CatchUp", "CheckIn", "Reconnect"],
}

const DEFAULT_MODALITY: Record<ContactType, Modality> = {
  Agent:    "Reconnect",
  Vendor:   "Referral",
  Investor: "Reconnect",
  PrivateMoney: "Reconnect",
  Seller:   "Reconnect",
  PM:       "Portfolio",
  Personal: "CheckIn",
}

// ── Intent × Familiarity — the two-knob picker that replaces the 3 near-
// identical modalities. Intent = what Ryan wants from the message; Familiarity
// = does the contact know him (controls the opener / self-intro). These map to
// the internal Modality, which stays the canonical key for messages + logging.
type Intent = "CatchUp" | "Deal" | "Referral" | "Portfolio"
type Familiarity = "Knows" | "Reintro"

const INTENT_LABEL: Record<Intent, string> = {
  CatchUp: "Catch up", Deal: "Looking for deals", Referral: "Referral", Portfolio: "Portfolio",
}
const INTENTS_BY_TYPE: Record<ContactType, Intent[]> = {
  Agent:        ["Deal", "CatchUp"],
  Investor:     ["Deal", "CatchUp"],
  Seller:       ["Deal", "CatchUp"],
  PrivateMoney: ["Deal", "CatchUp"],
  Vendor:       ["Referral", "CatchUp"],
  PM:           ["Portfolio", "CatchUp"],
  Personal:     ["CatchUp"],
}
const FAMILIARITY_LABEL: Record<Familiarity, string> = { Knows: "Knows me", Reintro: "Reintro" }

// (type, intent, familiarity) → canonical Modality. MUST match the server's
// resolveModality in app/api/crms/generate/route.ts.
function resolveModality(type: ContactType, intent: Intent, familiarity: Familiarity): Modality {
  if (type === "Personal") return "CatchUp"
  if (type === "Vendor") return intent === "Referral" ? "Referral" : "Familiar"
  if (type === "PM") return intent === "CatchUp" ? "CatchUp" : "Portfolio"
  if (intent === "CatchUp") return "CatchUp"
  return familiarity === "Knows" ? "Familiar" : "ColdReintro"
}

// Reverse: which Intent does a stored/canonical Modality represent (for the
// picker's highlighted state when modality is set by selection/advance/prefs).
function modalityToIntent(m: Modality): Intent {
  if (m === "Referral") return "Referral"
  if (m === "Portfolio") return "Portfolio"
  if (m === "CatchUp" || m === "CheckIn") return "CatchUp"
  return "Deal" // Familiar | Reconnect | ColdReintro
}

// Familiarity is shown only when it changes the opener (Deal + CatchUp). For
// Referral / Portfolio the template owns the opener, so the knob is hidden.
function familiarityApplies(intent: Intent): boolean {
  return intent === "Deal" || intent === "CatchUp"
}

// Default the familiarity knob from contact history: recently-in-touch contacts
// know Ryan (no self-intro); never/long-ago default to a reintro opener.
function deriveFamiliarity(contact: { lastContact?: string; lastContacted?: string } | null): Familiarity {
  if (!contact || contact.lastContact === "never" || !contact.lastContacted) return "Reintro"
  const t = new Date(contact.lastContacted).getTime()
  if (!Number.isFinite(t)) return "Reintro"
  const days = (Date.now() - t) / 86_400_000
  return days <= 120 ? "Knows" : "Reintro"
}

const TIERS: Tier[] = ["A", "B", "C", "D", "E"]

const TYPE_LABEL: Record<ContactType, string> = {
  Agent: "Agent", Personal: "Personal", Vendor: "Vendor",
  PM: "PM", Investor: "Investor", PrivateMoney: "Private Money", Seller: "Seller",
}

const TYPE_LABEL_PLURAL: Record<ContactType, string> = {
  Agent: "Agents", Personal: "Personal", Vendor: "Vendors",
  PM: "PMs", Investor: "Investors", PrivateMoney: "Private Money", Seller: "Sellers",
}

const ALL_TYPES: ContactType[] = ["Agent", "Vendor", "Personal", "PM", "Investor", "PrivateMoney", "Seller"]

const QUICK_EMOJIS = ["👍", "🙏", "💪", "😂", "🔥", "✅"]

function coerceType(t: unknown): ContactType {
  if (typeof t !== "string") return "Agent"
  if (t === "Property Manager") return "PM"
  if (t === "Personal Contact") return "Personal"
  if (t === "Private Money" || t === "Private money") return "PrivateMoney"
  if (ALL_TYPES.includes(t as ContactType)) return t as ContactType
  return "Agent"
}

function coerceModality(m: unknown, type: ContactType): Modality {
  const allowed = MODALITIES_BY_TYPE[type]
  if (typeof m === "string") {
    if ((allowed as string[]).includes(m)) return m as Modality
    if (m === "Cold Reintro" && (allowed as string[]).includes("ColdReintro")) return "ColdReintro"
    if (m === "Catch Up" && (allowed as string[]).includes("CatchUp")) return "CatchUp"
    if (m === "Check In" && (allowed as string[]).includes("CheckIn")) return "CheckIn"
    if (m === "Casual" && (allowed as string[]).includes("Familiar")) return "Familiar"
    if ((m === "Direct" || m === "Collaborative") && (allowed as string[]).includes("Reconnect")) return "Reconnect"
    if (m === "Check-in" && (allowed as string[]).includes("ColdReintro")) return "ColdReintro"
  }
  return DEFAULT_MODALITY[type]
}

interface CRMSContact {
  id:            string
  name:          string
  category:      ContactType
  type:          ContactType
  tier:          Tier
  phone:         string
  lastContact:   string
  lastContacted: string
  daysOverdue:   number
  status:        "due" | "overdue"
  notes:         string
  hasNotes:      boolean
  notesStale:    boolean
  dnc?:          boolean   // removed from rotation (status = do_not_contact)
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

const categoryColor: Record<ContactType, string> = {
  Agent:    "text-violet-400",
  Personal: "text-pink-400",
  Vendor:   "text-orange-400",
  Investor: "text-blue-400",
  PrivateMoney: "text-lime-400",
  Seller:   "text-emerald-400",
  PM:       "text-teal-400",
}

const categoryIcon: Record<ContactType, LucideIcon> = {
  Agent:    UserCheck,
  Personal: User,
  Vendor:   Wrench,
  Investor: TrendingUp,
  PrivateMoney: Banknote,
  Seller:   Home,
  PM:       Building2,
}

const categoryBadge: Record<ContactType, string> = {
  Agent:    "bg-violet-500/15 text-violet-300 border-violet-500/30",
  Personal: "bg-pink-500/15 text-pink-300 border-pink-500/30",
  Vendor:   "bg-orange-500/15 text-orange-300 border-orange-500/30",
  Investor: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  PrivateMoney: "bg-lime-500/15 text-lime-300 border-lime-500/30",
  Seller:   "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  PM:       "bg-teal-500/15 text-teal-300 border-teal-500/30",
}

// ══════════════════════════════════════════════════════════════════════════════
// SESSION STORAGE (progress survives refresh)
// ══════════════════════════════════════════════════════════════════════════════

// Daily progress lives in localStorage (date-keyed) so it survives tab kills
// and browser restarts. sessionStorage was wrong — a freeze/reload on mobile
// would reset the 8/15 counter back to 0/15.
const SESSION_KEY_PREFIX = "crms-session-"
const sessionKey = () => `${SESSION_KEY_PREFIX}${new Date().toISOString().slice(0, 10)}`

function loadSession(): { sent: string[]; skipped: string[] } {
  try {
    if (typeof window === "undefined") return { sent: [], skipped: [] }
    const raw = localStorage.getItem(sessionKey())
    if (!raw) return { sent: [], skipped: [] }
    const parsed = JSON.parse(raw)
    return { sent: parsed.sent || [], skipped: parsed.skipped || [] }
  } catch { return { sent: [], skipped: [] } }
}

function saveSession(sent: Set<string>, skipped: Set<string>) {
  try {
    if (typeof window === "undefined") return
    localStorage.setItem(sessionKey(), JSON.stringify({
      sent: Array.from(sent),
      skipped: Array.from(skipped),
    }))
  } catch {}
}

function pruneOldSessions() {
  try {
    if (typeof window === "undefined") return
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    const keep = new Set([`${SESSION_KEY_PREFIX}${today}`, `${SESSION_KEY_PREFIX}${yesterday}`])
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(SESSION_KEY_PREFIX) && !keep.has(key)) {
        localStorage.removeItem(key)
      }
    }
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

// Pre-fetch fallback only — the API's dailyTarget (lib/relationships
// DAILY_TARGETS) overwrites this on load. Keep the two in sync.
const DEFAULT_DAILY_TARGET: Record<ContactType, number> = {
  Agent: 2, Vendor: 1, Personal: 1, PM: 0, Investor: 0, PrivateMoney: 1, Seller: 0,
}

function formatAbsoluteDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function daysAgoHint(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  const days = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (days < 0) return ""
  if (days === 0) return "(today)"
  if (days === 1) return "(1d ago)"
  return `(${days}d ago)`
}

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
  const [dailyTarget, setDailyTarget]         = useState<Record<ContactType, number>>(DEFAULT_DAILY_TARGET)
  const [loadingContacts, setLoadingContacts] = useState(true)
  const [contactsError, setContactsError]     = useState<string | null>(null)

  // ── Relationship search (full BoB sheet, lazy-loaded on first focus) ──
  const [searchQuery, setSearchQuery]             = useState("")
  const [allContacts, setAllContacts]             = useState<CRMSContact[]>([])
  const [allContactsLoaded, setAllContactsLoaded] = useState(false)
  const [loadingAll, setLoadingAll]               = useState(false)

  // ── Session state ──
  const [selectedId, setSelectedId]   = useState<string>("")
  const [modality, setModality]       = useState<Modality>("Reconnect")
  const [familiarity, setFamiliarity] = useState<Familiarity>("Reintro")
  const [sent, setSent]               = useState<Set<string>>(() => new Set(loadSession().sent))
  const [skipped, setSkipped]         = useState<Set<string>>(() => new Set(loadSession().skipped))
  // Removed-from-rotation this session — persisted server-side (status =
  // do_not_contact), the Set just hides them without a queue refetch.
  const [removed, setRemoved]         = useState<Set<string>>(new Set())
  const [removeUndo, setRemoveUndo]   = useState<{ id: string; name: string } | null>(null)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [mobileView, setMobileView]   = useState<"list" | "compose">("list")
  const [sendError, setSendError]     = useState<string | null>(null)
  const [sendToast, setSendToast]     = useState<string | null>(null)
  const [touchesByPhone, setTouchesByPhone] = useState<Record<string, TouchesSummary>>({})
  const [detailPhone, setDetailPhone] = useState<string | null>(null)

  // ── Message state ──
  const [generatedMessages, setGeneratedMessages] = useState<Record<string, string>>({})
  const [editedMessages, setEditedMessages]       = useState<Record<string, string>>({})
  const [generatingFor, setGeneratingFor]         = useState<string | null>(null)
  const [enrichingFor, setEnrichingFor]           = useState<string | null>(null)
  const [tierChangingFor, setTierChangingFor]     = useState<string | null>(null)
  const [categoryChangingFor, setCategoryChangingFor] = useState<string | null>(null)
  const [categoryPickerOpen, setCategoryPickerOpen]   = useState(false)
  const [actionPending, setActionPending]         = useState(false)

  // ── Refs for debounce + abort ──
  const generateAbortRef = useRef<AbortController | null>(null)
  const selectDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const removeUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const categoryPickerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const allLoadRef = useRef(false)

  // Close the category picker when the user taps outside. Uses pointerdown
  // (fires before click) and a setTimeout so the tap that opened the picker
  // doesn't immediately close it on iOS Safari.
  useEffect(() => {
    if (!categoryPickerOpen) return
    const handler = (e: PointerEvent) => {
      if (categoryPickerRef.current && !categoryPickerRef.current.contains(e.target as Node)) {
        setCategoryPickerOpen(false)
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", handler)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("pointerdown", handler)
    }
  }, [categoryPickerOpen])

  function showSendToast(msg: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setSendToast(msg)
    toastTimerRef.current = setTimeout(() => setSendToast(null), 5000)
  }

  async function fetchTouches(phone: string) {
    if (!phone || touchesByPhone[phone]) return
    try {
      const res = await fetch(`/api/crms/touches?phone=${encodeURIComponent(phone)}`, { cache: "no-store" })
      const data = await res.json()
      setTouchesByPhone(prev => ({
        ...prev,
        [phone]: {
          count: data.count ?? 0,
          lastSentAt: data.lastSentAt ?? null,
          lastMessagePreview: data.lastMessagePreview ?? null,
          hasReply: data.hasReply ?? false,
        },
      }))
    } catch {}
  }

  // Persist session progress on change
  useEffect(() => { saveSession(sent, skipped) }, [sent, skipped])

  // Fetch contacts on mount
  useEffect(() => {
    pruneOldSessions()
    fetchContacts()
    return () => {
      if (selectDebounceRef.current) clearTimeout(selectDebounceRef.current)
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      if (removeUndoTimerRef.current) clearTimeout(removeUndoTimerRef.current)
      generateAbortRef.current?.abort()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchContacts() {
    setLoadingContacts(true)
    setContactsError(null)
    try {
      const res = await fetch("/api/crms/contacts", { cache: "no-store" })
      if (!res.ok) throw new Error()
      const data = await res.json()
      const loaded: CRMSContact[] = (data.contacts || []).map((c: CRMSContact) => ({
        ...c,
        type: coerceType(c.type ?? c.category),
        category: coerceType(c.type ?? c.category),
      }))
      setContacts(loaded)
      setTotal(data.total || 0)
      if (data.dailyTarget) setDailyTarget({ ...DEFAULT_DAILY_TARGET, ...data.dailyTarget })

      // Auto-select first contact not already sent/skipped
      const firstDue = loaded.find(c => !sent.has(c.id) && !skipped.has(c.id))
      if (firstDue) {
        setSelectedId(firstDue.id)
        const initialMod = DEFAULT_MODALITY[firstDue.type]
        setModality(initialMod)
        generate(firstDue, initialMod)
        fetchTouches(firstDue.phone)
      }
    } catch {
      setContactsError("Could not load contacts — check the database connection.")
    } finally {
      setLoadingContacts(false)
    }
  }

  // Lazy-load the full BoB sheet the first time the search box is focused.
  // Separate from fetchContacts (which only returns today's capped queue).
  async function ensureAllContacts() {
    if (allLoadRef.current || loadingAll) return
    allLoadRef.current = true
    setLoadingAll(true)
    try {
      const res = await fetch("/api/crms/all-contacts", { cache: "no-store" })
      if (!res.ok) throw new Error()
      const data = await res.json()
      const loaded: CRMSContact[] = (data.contacts || []).map((c: CRMSContact) => ({
        ...c,
        type: coerceType(c.type ?? c.category),
        category: coerceType(c.type ?? c.category),
      }))
      setAllContacts(loaded)
      setAllContactsLoaded(true)
    } catch {
      allLoadRef.current = false // allow a retry on the next focus
    } finally {
      setLoadingAll(false)
    }
  }

  // ── Core generate — aborts any prior in-flight request ──
  async function generate(contact: CRMSContact, mod: Modality, force = false, famOverride?: Familiarity) {
    const fam = famOverride ?? familiarity
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
          name:          contact.name,
          phone:         contact.phone,
          tier:          contact.tier,
          category:      contact.type,
          modality:      mod,
          intent:        modalityToIntent(mod),
          familiarity:   fam,
          notes:         contact.notes,
          hasNotes:      contact.hasNotes,
          everContacted: contact.lastContact !== "never",
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
    setCategoryPickerOpen(false)
    fetchTouches(contact.phone)
    setFamiliarity(deriveFamiliarity(contact))

    // If current modality isn't valid for this type, snap to type's default
    let initialMod: Modality = (MODALITIES_BY_TYPE[contact.type] as string[]).includes(modality)
      ? modality
      : DEFAULT_MODALITY[contact.type]
    setModality(initialMod)

    if (selectDebounceRef.current) clearTimeout(selectDebounceRef.current)
    selectDebounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/crms/generate?phone=${encodeURIComponent(contact.phone)}`)
        const data = await res.json()
        if (data.preferred_modality) {
          initialMod = coerceModality(data.preferred_modality, contact.type)
          setModality(initialMod)
        }
      } catch {}
      generate(contact, initialMod)
    }, GENERATE_DEBOUNCE_MS)
  }

  // Picker: pick what Ryan wants from the message. Resolves to a canonical
  // modality (with the current familiarity) and regenerates.
  function handleIntentChange(nextIntent: Intent) {
    if (!selectedContact) return
    const m = resolveModality(selectedContact.type, nextIntent, familiarity)
    setModality(m)
    generate(selectedContact, m, true)
  }

  // Picker: flip the opener (knows-me vs reintro). For Deal this swaps
  // Familiar↔ColdReintro; for CatchUp the modality is unchanged so we force a
  // regen, passing the new familiarity explicitly (state update is async).
  function handleFamiliarityChange(nextFam: Familiarity) {
    if (!selectedContact) return
    setFamiliarity(nextFam)
    const intent = modalityToIntent(modality)
    const m = resolveModality(selectedContact.type, intent, nextFam)
    setModality(m)
    generate(selectedContact, m, true, nextFam)
  }

  async function regenerate() {
    if (!selectedContact || generatingFor) return
    const msgKey = `${selectedContact.id}::${modality}`
    setEditedMessages(prev => { const n = { ...prev }; delete n[msgKey]; return n })
    setGeneratedMessages(prev => { const n = { ...prev }; delete n[msgKey]; return n })
    await generate(selectedContact, modality, true)
  }

  // ── Category change: PATCH sheet + update local state ──
  async function handleCategoryChange(newCategory: ContactType) {
    if (!selectedContact || categoryChangingFor) return
    setCategoryPickerOpen(false)
    if (selectedContact.type === newCategory) return
    const targetId = selectedContact.id
    setCategoryChangingFor(targetId)
    try {
      const res = await fetch("/api/crms/category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: targetId, category: newCategory }),
      })
      if (!res.ok) throw new Error()
      setContacts(prev => prev.map(c =>
        c.id === targetId ? { ...c, type: newCategory, category: newCategory } : c
      ))
      const allowed = MODALITIES_BY_TYPE[newCategory] as string[]
      if (!allowed.includes(modality)) {
        const next = DEFAULT_MODALITY[newCategory]
        setModality(next)
        // Regenerate for the new type — use the updated contact shape
        const updated = { ...selectedContact, type: newCategory, category: newCategory }
        generate(updated, next, true)
      }
    } catch {
      setSendError("Type update failed — try again")
    } finally {
      setCategoryChangingFor(null)
    }
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
        body: JSON.stringify({ id: selectedContact.id, tier: newTier }),
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

  // ── Send: advance UI immediately; fire API calls in background ──
  function handleSend() {
    if (!selectedContact) return
    const message = getMessage(selectedContact)
    if (!message) return

    const contact = selectedContact
    const mod = modality
    const msgKey = `${contact.id}::${mod}`
    const generatedMessage = generatedMessages[msgKey] || ""
    const wasEdited = editedMessages[msgKey] !== undefined
    setSendError(null)

    // Optimistic: mark sent and advance immediately
    setSent(prev => new Set(prev).add(contact.id))
    advanceSelection(contact.id)

    // Fire send in background
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)

    fetch("/api/crms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: contact.phone, message }),
      signal: controller.signal,
    })
      .then(async res => {
        clearTimeout(timeout)
        if (!res.ok) throw new Error(`send ${res.status}`)

        // Await the log call so we can detect a failed LastContacted write.
        // If it fails, the contact will re-appear tomorrow — warn the user.
        try {
          const logRes = await fetch("/api/crms/log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: contact.id, modality: mod, message,
              action: "sent", tier: contact.tier, category: contact.type,
              generatedMessage, wasEdited,
            }),
          })
          if (!logRes.ok) {
            showSendToast(`Sent to ${contact.name} but failed to record date — will re-appear`)
          } else {
            const logData = await logRes.json().catch(() => ({}))
            if (logData?.lastContactedWritten === false) {
              showSendToast(`Sent to ${contact.name} but failed to record date — will re-appear`)
            }
          }
        } catch (e) {
          console.error("Log call failed:", e)
          showSendToast(`Sent to ${contact.name} but failed to record date — will re-appear`)
        }

        fetch("/api/crms/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: contact.name, phone: contact.phone,
            tier: contact.tier, category: contact.type,
            modality: mod, notes: contact.notes, hasNotes: contact.hasNotes,
            savePreference: true,
          }),
        }).catch(() => {})
      })
      .catch(err => {
        clearTimeout(timeout)
        const aborted = (err as Error)?.name === "AbortError"
        const label = aborted ? "timed out" : "failed"
        console.error(`Send to ${contact.name} ${label}:`, err)
        showSendToast(`Send to ${contact.name} ${label}`)
      })
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
          id: contact.id, modality, message: "",
          action: "skipped", tier: contact.tier, category: contact.type,
        }),
      })
    } catch {}
    setSkipped(prev => new Set(prev).add(contact.id))
    advanceSelection(contact.id)
    setActionPending(false)
  }

  // ── Remove from rotation: status → do_not_contact. Unlike Skip (24h snooze)
  // this is permanent — the contact never surfaces in the queue again. The
  // toast offers an 8s Undo; after that, restorable from Cleanup mode.
  async function handleRemove() {
    if (!selectedContact || actionPending) return
    const contact = selectedContact
    setActionPending(true)
    try {
      const res = await fetch("/api/crms/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: contact.id, verdict: "never" }),
      })
      if (!res.ok) throw new Error()
      setRemoved(prev => new Set(prev).add(contact.id))
      if (removeUndoTimerRef.current) clearTimeout(removeUndoTimerRef.current)
      setRemoveUndo({ id: contact.id, name: contact.name })
      removeUndoTimerRef.current = setTimeout(() => setRemoveUndo(null), 8000)
      advanceSelection(contact.id)
    } catch {
      setSendError("Remove failed — try again")
    } finally {
      setActionPending(false)
    }
  }

  async function handleUndoRemove() {
    if (!removeUndo) return
    const { id, name } = removeUndo
    setRemoveUndo(null)
    if (removeUndoTimerRef.current) clearTimeout(removeUndoTimerRef.current)
    try {
      const res = await fetch("/api/crms/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, verdict: "undo" }),
      })
      if (!res.ok) throw new Error()
      setRemoved(prev => { const n = new Set(prev); n.delete(id); return n })
    } catch {
      showSendToast(`Couldn't restore ${name} — open Cleanup to restore them`)
    }
  }

  // ── Mark Done: contact was already reached out to (e.g. via Messages directly).
  // Writes a "sent" Log row + LastContacted date without firing iMessage.
  async function handleMarkDone() {
    if (!selectedContact || actionPending) return
    const contact = selectedContact
    const mod = modality
    setActionPending(true)

    // Optimistic: mark sent + advance immediately
    setSent(prev => new Set(prev).add(contact.id))
    advanceSelection(contact.id)

    try {
      const logRes = await fetch("/api/crms/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: contact.id, modality: mod, message: "[marked contacted manually]",
          action: "sent", tier: contact.tier, category: contact.type,
          generatedMessage: "", wasEdited: false,
        }),
      })
      if (!logRes.ok) {
        showSendToast(`Marked ${contact.name} done but failed to record date — will re-appear`)
      } else {
        const logData = await logRes.json().catch(() => ({}))
        if (logData?.lastContactedWritten === false) {
          showSendToast(`Marked ${contact.name} done but failed to record date — will re-appear`)
        }
      }
    } catch (e) {
      console.error("Mark Done log failed:", e)
      showSendToast(`Marked ${contact.name} done but failed to record date — will re-appear`)
    } finally {
      setActionPending(false)
    }
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
      c.id !== excludeId && !sent.has(c.id) && !skipped.has(c.id) && !removed.has(c.id)
    )
    const next = remaining[0]
    if (!next) { setSelectedId(""); setMobileView("list"); return }
    setSelectedId(next.id)
    setFamiliarity(deriveFamiliarity(next))
    const nextMod: Modality = (MODALITIES_BY_TYPE[next.type] as string[]).includes(modality)
      ? modality
      : DEFAULT_MODALITY[next.type]
    if (nextMod !== modality) setModality(nextMod)
    generate(next, nextMod)
    fetchTouches(next.phone)
  }

  function getMessage(contact: CRMSContact): string {
    const msgKey = `${contact.id}::${modality}`
    return editedMessages[msgKey] ?? generatedMessages[msgKey] ?? ""
  }

  function handleEdit(value: string) {
    if (!selectedContact) return
    setEditedMessages(prev => ({ ...prev, [`${selectedContact.id}::${modality}`]: value }))
  }

  function insertAtCursor(text: string) {
    const ta = textareaRef.current
    if (!ta || !selectedContact) return
    const start = ta.selectionStart ?? ta.value.length
    const end = ta.selectionEnd ?? ta.value.length
    const newVal = ta.value.slice(0, start) + text + ta.value.slice(end)
    handleEdit(newVal)
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + text.length
      ta.focus()
    })
  }

  // ── Derived ──
  const dueContacts     = contacts.filter(c => !sent.has(c.id) && !skipped.has(c.id) && !removed.has(c.id))
  const selectedContact = dueContacts.find(c => c.id === selectedId) ?? null

  // Per-type sent counts (for progress bar)
  const sentByType = useMemo(() => {
    const counts: Record<ContactType, number> = {
      Agent: 0, Vendor: 0, Personal: 0, PM: 0, Investor: 0, PrivateMoney: 0, Seller: 0,
    }
    for (const c of contacts) {
      if (sent.has(c.id)) counts[c.type] = (counts[c.type] || 0) + 1
    }
    return counts
  }, [contacts, sent])

  const totalTarget = ALL_TYPES.reduce((s, t) => s + (dailyTarget[t] || 0), 0)
  const totalSent = ALL_TYPES.reduce((s, t) => s + sentByType[t], 0)
  const allDone = totalSent >= totalTarget && totalTarget > 0
  const progressPct = totalTarget > 0 ? Math.min(100, Math.round((totalSent / totalTarget) * 100)) : 0

  const isGenerating   = generatingFor === selectedContact?.id
  const isEnriching    = enrichingFor  === selectedContact?.id
  const isChangingTier = tierChangingFor === selectedContact?.id
  const currentMessage = selectedContact ? getMessage(selectedContact) : ""
  const touches        = selectedContact ? touchesByPhone[selectedContact.phone] : undefined
  const detailContact  = detailPhone
    ? (contacts.find(c => c.phone === detailPhone)
        ?? allContacts.find(c => c.phone === detailPhone)
        ?? null)
    : null

  // Search across the full BoB sheet — name / phone / type / tier / notes.
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return []
    const qDigits = q.replace(/\D/g, "")
    return allContacts
      .filter(c => {
        if (c.name.toLowerCase().includes(q)) return true
        if (qDigits && c.phone.includes(qDigits)) return true
        if (c.type.toLowerCase().includes(q)) return true
        if (c.tier.toLowerCase() === q) return true
        if (c.notes && c.notes.toLowerCase().includes(q)) return true
        return false
      })
      .slice(0, 40)
  }, [searchQuery, allContacts])

  const availableIntents: Intent[] = selectedContact
    ? INTENTS_BY_TYPE[selectedContact.type]
    : INTENTS_BY_TYPE.Agent
  const currentIntent: Intent = modalityToIntent(modality)

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

  // ── Cleanup mode takes over the whole tab. On exit, refetch the queue and
  // drop the search cache — tiers/statuses likely changed underneath both.
  if (cleanupOpen) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div>
            <p className="text-sm font-semibold text-zinc-100">Cleanup</p>
            <p className="text-xs text-zinc-500">Triage the full book — Keep, Vague (→ tier D), or Never (do not contact)</p>
          </div>
          <button
            onClick={() => {
              setCleanupOpen(false)
              fetchContacts()
              allLoadRef.current = false
              setAllContacts([])
              setAllContactsLoaded(false)
            }}
            className="ml-auto flex items-center gap-1.5 text-xs text-zinc-300 bg-zinc-800 border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 rounded transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            Exit
          </button>
        </div>
        <CleanupMode onToast={showSendToast} />
        {sendToast && (
          <div className="fixed bottom-4 right-4 z-50 bg-red-500/15 border border-red-500/40 text-red-300 text-xs px-3 py-2 rounded shadow-lg flex items-center gap-2 max-w-xs">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{sendToast}</span>
            <button onClick={() => setSendToast(null)} className="text-red-400 hover:text-red-200 shrink-0" aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">

      {/* Progress bar */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-3">
          {allDone ? (
            <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Done for today
            </div>
          ) : (
            <span className="text-xs text-zinc-300 font-medium">
              {totalSent} / {totalTarget} done today
            </span>
          )}
          <div className="flex-1 h-1.5 bg-zinc-800 rounded overflow-hidden">
            <div
              className={`h-full transition-all ${allDone ? "bg-emerald-500" : "bg-blue-500"}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <button onClick={fetchContacts} className="text-zinc-600 hover:text-zinc-400 transition-colors" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
          {ALL_TYPES.map(t => {
            const target = dailyTarget[t] || 0
            if (target === 0) return null
            const done = sentByType[t] || 0
            const hit = done >= target
            return (
              <span key={t} className={hit ? "text-emerald-400" : ""}>
                {TYPE_LABEL_PLURAL[t]}: {done}/{target}
              </span>
            )
          })}
        </div>
      </div>

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
        <button
          onClick={() => setCleanupOpen(true)}
          title="Bulk-triage the full book — Keep / Vague / Never"
          className="ml-auto flex items-center gap-1.5 text-xs font-medium text-purple-300 bg-purple-500/10 border border-purple-500/30 hover:border-purple-500/50 px-3 py-1.5 rounded transition-colors"
        >
          <ListChecks className="w-3.5 h-3.5" />
          Cleanup
        </button>
      </div>

      {/* Relationship search — look up anyone in the BoB sheet, not just today's queue */}
      <div>
        <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2">
          <Search className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onFocus={ensureAllContacts}
            placeholder="Search all relationships — name, phone, type, or notes…"
            className="flex-1 bg-transparent text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
            style={{ fontSize: "16px" }}
          />
          {loadingAll && <Loader2 className="w-3.5 h-3.5 text-zinc-600 animate-spin shrink-0" />}
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="text-zinc-600 hover:text-zinc-300 shrink-0"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {searchQuery.trim() && (
          <div className="mt-1 bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800 max-h-[360px] overflow-y-auto">
            {searchResults.length === 0 ? (
              <p className="text-xs text-zinc-600 px-3 py-3">
                {loadingAll || !allContactsLoaded ? "Loading contacts…" : "No matches"}
              </p>
            ) : (
              searchResults.map(c => {
                const Icon = categoryIcon[c.type] ?? User
                const isRemoved = c.dnc || removed.has(c.id)
                return (
                  <button
                    key={c.id}
                    onClick={() => setDetailPhone(c.phone)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-zinc-800 transition-colors ${isRemoved ? "opacity-60" : ""}`}
                  >
                    <span className={`text-xs font-bold px-1 py-0.5 rounded border leading-none shrink-0 ${tierStyle[c.tier] ?? tierStyle.C}`}>
                      {c.tier}
                    </span>
                    <Icon className={`w-3.5 h-3.5 shrink-0 ${categoryColor[c.type] ?? "text-zinc-400"}`} />
                    <span className={`text-xs font-medium truncate flex-1 min-w-0 ${isRemoved ? "text-zinc-500 line-through" : "text-zinc-200"}`}>{c.name}</span>
                    {isRemoved && (
                      <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30 shrink-0 leading-none">
                        removed
                      </span>
                    )}
                    <span className="text-xs text-zinc-600 shrink-0 hidden sm:block">{TYPE_LABEL[c.type]}</span>
                    <span className="text-xs text-zinc-600 font-mono shrink-0">{c.phone}</span>
                  </button>
                )
              })
            )}
          </div>
        )}
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
              const Icon     = categoryIcon[contact.type] ?? User
              const isActive = contact.id === selectedContact?.id
              return (
                <div
                  key={contact.id}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                    isActive
                      ? "bg-zinc-800 border-zinc-600"
                      : "bg-zinc-900 border-zinc-800"
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={`text-xs font-bold px-1 py-0.5 rounded border leading-none ${tierStyle[contact.tier] ?? tierStyle.C}`}>
                      {contact.tier}
                    </span>
                    <Icon className={`w-3 h-3 shrink-0 ${categoryColor[contact.type] ?? "text-zinc-400"}`} />
                    {contact.status === "overdue" && (
                      <span className="ml-auto w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" title="Overdue" />
                    )}
                    {contact.notesStale && (
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 ml-auto" title="Notes stale" />
                    )}
                    {(() => {
                      const t = touchesByPhone[contact.phone]
                      return t && t.count > 0 && !t.hasReply ? (
                        <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-zinc-700 text-zinc-400 border border-zinc-600 shrink-0 ml-auto leading-none" title="No reply yet — consider downgrading">
                          no reply
                        </span>
                      ) : null
                    })()}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSelectContact(contact)}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelectContact(contact) } }}
                    className="text-xs font-medium text-zinc-200 truncate leading-snug hover:text-emerald-400 hover:underline underline-offset-2 block text-left w-full"
                  >
                    {contact.name}
                  </button>
                  <p className={`text-xs truncate leading-snug ${categoryColor[contact.type] ?? "text-zinc-400"}`}>
                    {TYPE_LABEL[contact.type]}
                  </p>
                  <p className="text-xs text-zinc-600 mt-0.5">{contact.lastContact}</p>
                </div>
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
                  <button
                    type="button"
                    onClick={() => setDetailPhone(selectedContact.phone)}
                    className="text-sm font-semibold text-zinc-100 hover:text-emerald-400 hover:underline underline-offset-2"
                    title="Open full contact detail"
                  >
                    {selectedContact.name}
                  </button>
                  <div className="relative" ref={categoryPickerRef}>
                    <button
                      type="button"
                      onClick={() => setCategoryPickerOpen(o => !o)}
                      disabled={!!categoryChangingFor}
                      title="Change contact type"
                      className={`text-xs px-2 py-1 rounded border leading-none transition-colors hover:brightness-125 disabled:opacity-50 ${categoryBadge[selectedContact.type] ?? ""}`}
                    >
                      {TYPE_LABEL[selectedContact.type]}
                      {categoryChangingFor === selectedContact.id && (
                        <Loader2 className="inline-block w-3 h-3 animate-spin ml-1 -mb-0.5" />
                      )}
                    </button>
                    {categoryPickerOpen && (
                      <div className="absolute left-0 top-full mt-1 z-40 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl p-1.5 flex flex-col gap-1 min-w-[160px]">
                        {ALL_TYPES.map(t => {
                          const Icon = categoryIcon[t] ?? User
                          const isCurrent = selectedContact.type === t
                          return (
                            <button
                              key={t}
                              type="button"
                              onClick={() => handleCategoryChange(t)}
                              disabled={isCurrent}
                              className={`flex items-center gap-2 text-sm px-3 py-2.5 rounded border leading-none transition-colors text-left min-h-[40px] ${
                                isCurrent
                                  ? categoryBadge[t]
                                  : "bg-transparent text-zinc-300 border-transparent hover:bg-zinc-800 hover:border-zinc-700 active:bg-zinc-800"
                              }`}
                            >
                              <Icon className={`w-4 h-4 shrink-0 ${categoryColor[t] ?? "text-zinc-400"}`} />
                              {TYPE_LABEL[t]}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
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

                {/* Structured fields */}
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mb-3 text-xs">
                  <span className="text-zinc-600">Last contacted</span>
                  <span className="text-zinc-300">
                    {formatAbsoluteDate(selectedContact.lastContacted || null)}
                    {selectedContact.lastContacted && (
                      <span className="text-zinc-600 ml-1">{daysAgoHint(selectedContact.lastContacted)}</span>
                    )}
                  </span>
                  <span className="text-zinc-600"># of touches</span>
                  <span className="text-zinc-300">
                    {touches ? touches.count : <span className="text-zinc-600">…</span>}
                  </span>
                  {touches?.lastMessagePreview && (
                    <>
                      <span className="text-zinc-600">Last message</span>
                      <span className="text-zinc-400 italic leading-snug">
                        &ldquo;{touches.lastMessagePreview}&rdquo;
                        <span className="text-zinc-600 not-italic ml-1">{daysAgoHint(touches.lastSentAt)}</span>
                      </span>
                    </>
                  )}
                </div>

                <p className="text-xs text-zinc-600 mb-1">Notes</p>
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

              {/* Intent + Familiarity selector */}
              <div className="px-4 py-2.5 border-b border-zinc-800 space-y-2">
                {/* Intent — what Ryan wants from the message */}
                <div className="flex gap-2 flex-wrap items-center">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-600 w-14 shrink-0">Intent</span>
                  {availableIntents.map(it => (
                    <button
                      key={it}
                      onClick={() => handleIntentChange(it)}
                      className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                        currentIntent === it
                          ? "bg-blue-500/10 text-blue-400 border-blue-500/40"
                          : "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
                      }`}
                    >
                      {INTENT_LABEL[it]}
                    </button>
                  ))}
                </div>
                {/* Familiarity — controls the opener (self-intro or not) */}
                {familiarityApplies(currentIntent) && (
                  <div className="flex gap-2 flex-wrap items-center">
                    <span className="text-[10px] uppercase tracking-wide text-zinc-600 w-14 shrink-0">They</span>
                    {(["Knows", "Reintro"] as Familiarity[]).map(f => (
                      <button
                        key={f}
                        onClick={() => handleFamiliarityChange(f)}
                        className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                          familiarity === f
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/40"
                            : "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
                        }`}
                      >
                        {FAMILIARITY_LABEL[f]}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Message */}
              <div className="px-4 py-3">
                {isGenerating ? (
                  <div className="flex items-center justify-center gap-2 bg-zinc-800 border border-zinc-700 rounded h-20">
                    <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
                    <span className="text-xs text-zinc-500">Generating…</span>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-1 mb-1.5 flex-wrap">
                      {QUICK_EMOJIS.map(emoji => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => insertAtCursor(emoji)}
                          className="text-lg px-1.5 py-0.5 rounded hover:bg-zinc-800 active:scale-95 transition-transform leading-none"
                          aria-label={`Insert ${emoji}`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                    <textarea
                      ref={el => {
                        textareaRef.current = el
                        if (el) {
                          // Auto-grow: reset then expand to scrollHeight (capped at 200px)
                          el.style.height = "auto"
                          const next = Math.min(el.scrollHeight, 200)
                          el.style.height = `${next}px`
                        }
                      }}
                      value={currentMessage}
                      onChange={e => {
                        handleEdit(e.target.value)
                        const el = e.target
                        el.style.height = "auto"
                        const next = Math.min(el.scrollHeight, 200)
                        el.style.height = `${next}px`
                      }}
                      rows={5}
                      className="w-full min-h-[120px] max-h-[200px] overflow-y-auto bg-zinc-800 border border-zinc-700 rounded px-3 py-2.5 text-zinc-200 leading-relaxed resize-none focus:outline-none focus:border-zinc-500 transition-colors"
                      style={{ fontSize: "16px" }}
                    />
                  </>
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

              {/* Action buttons — Skip, Mark Done (muted), Regenerate (secondary) + Send (primary) */}
              <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleSkip}
                  disabled={actionPending}
                  title="Not today — snoozes 24h"
                  className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
                >
                  <SkipForward className="w-3.5 h-3.5" />
                  Skip
                </button>
                <button
                  onClick={handleRemove}
                  disabled={actionPending}
                  title="Remove from rotation — never surfaces in the queue again"
                  className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 bg-red-500/10 border border-red-500/30 hover:border-red-500/50 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
                >
                  <X className="w-3.5 h-3.5" />
                  Remove
                </button>
                <button
                  onClick={handleMarkDone}
                  disabled={actionPending}
                  title="Mark as contacted (no message sent)"
                  className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" />
                  Mark Done
                </button>
                <button
                  onClick={regenerate}
                  disabled={!!generatingFor}
                  aria-label="Regenerate message"
                  title="Regenerate message"
                  className="ml-auto flex items-center justify-center text-zinc-500 hover:text-zinc-300 bg-transparent border border-zinc-700 hover:border-zinc-500 w-11 h-11 rounded transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${isGenerating ? "animate-spin" : ""}`} />
                </button>
                <button
                  onClick={handleSend}
                  disabled={isGenerating || !currentMessage}
                  className="flex items-center gap-1.5 text-sm font-medium text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 hover:border-emerald-500/50 px-4 py-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] ml-4"
                >
                  <Send className="w-4 h-4" />
                  Send
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

      {removeUndo && (
        <div className="fixed bottom-16 right-4 z-50 bg-zinc-900 border border-red-500/40 text-zinc-200 text-xs px-3 py-2.5 rounded shadow-lg flex items-center gap-2 max-w-xs">
          <X className="w-3.5 h-3.5 text-red-400 shrink-0" />
          <span className="flex-1"><span className="font-medium">{removeUndo.name}</span> removed from rotation</span>
          <button
            onClick={handleUndoRemove}
            className="flex items-center gap-1 text-blue-400 hover:text-blue-300 font-semibold shrink-0"
          >
            <Undo2 className="w-3.5 h-3.5" />
            Undo
          </button>
        </div>
      )}

      {sendToast && (
        <div className="fixed bottom-4 right-4 z-50 bg-red-500/15 border border-red-500/40 text-red-300 text-xs px-3 py-2 rounded shadow-lg flex items-center gap-2 max-w-xs">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">{sendToast}</span>
          <button
            onClick={() => setSendToast(null)}
            className="text-red-400 hover:text-red-200 shrink-0"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {detailContact && (
        <ContactDetailModal
          contact={detailContact}
          onClose={() => setDetailPhone(null)}
          onSendToast={showSendToast}
          onNotesSaved={(id, newNotes) => {
            const patch = (c: CRMSContact) =>
              c.id === id
                ? { ...c, notes: newNotes, hasNotes: newNotes.trim().length > 0, notesStale: false }
                : c
            setContacts(prev => prev.map(patch))
            setAllContacts(prev => prev.map(patch))
          }}
          onCategoryChanged={(id, newCategory) => {
            const next = coerceType(newCategory)
            const patch = (c: CRMSContact) =>
              c.id === id ? { ...c, type: next, category: next } : c
            setContacts(prev => prev.map(patch))
            setAllContacts(prev => prev.map(patch))
            // If the modal is on the currently selected contact, snap modality to a valid one
            if (selectedContact && selectedContact.id === id) {
              const allowed = MODALITIES_BY_TYPE[next] as string[]
              if (!allowed.includes(modality)) {
                const nextMod = DEFAULT_MODALITY[next]
                setModality(nextMod)
                const updated = { ...selectedContact, type: next, category: next }
                generate(updated, nextMod, true)
              }
            }
          }}
          onTierChanged={(id, newTier) => {
            const patch = (c: CRMSContact) =>
              c.id === id ? { ...c, tier: newTier as Tier } : c
            setContacts(prev => prev.map(patch))
            setAllContacts(prev => prev.map(patch))
          }}
        />
      )}
    </div>
  )
}
