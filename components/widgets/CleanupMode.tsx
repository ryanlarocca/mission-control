"use client"

import { useState, useEffect, useMemo } from "react"
import { Loader2, User, UserCheck, Wrench, TrendingUp, Home, Building2, Banknote } from "lucide-react"
import type { LucideIcon } from "lucide-react"

// Cleanup mode — bulk triage of the full Book of Business. One row per
// contact with a one-tap Keep / Vague / Never verdict that saves instantly
// (POST /api/crms/cleanup). Rows are served worst-avoided-first: contacts
// Ryan keeps skipping or pseudo-completing ("Mark Done" with no message)
// float to the top. Tapping an active verdict again undoes it.

type ContactType = "Agent" | "Personal" | "Vendor" | "PM" | "Investor" | "PrivateMoney" | "Seller"
type Verdict = "keep" | "vague" | "never"

interface CleanupContact {
  id: string
  name: string
  phone: string
  tier: string
  type: ContactType
  lastContact: string
  dnc: boolean
  cleanupVerdict: Verdict | null
  skips: number
  manualDones: number
  avoidance: number
}

const ALL_TYPES: ContactType[] = ["Agent", "Vendor", "Personal", "PM", "Investor", "PrivateMoney", "Seller"]

const TYPE_LABEL: Record<ContactType, string> = {
  Agent: "Agent", Personal: "Personal", Vendor: "Vendor",
  PM: "PM", Investor: "Investor", PrivateMoney: "Private Money", Seller: "Seller",
}

const tierStyle: Record<string, string> = {
  A: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  B: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  C: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  D: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  E: "bg-zinc-700/20 text-zinc-600 border-zinc-700/30",
}

const categoryColor: Record<ContactType, string> = {
  Agent: "text-violet-400", Personal: "text-pink-400", Vendor: "text-orange-400",
  Investor: "text-blue-400", PrivateMoney: "text-lime-400", Seller: "text-emerald-400", PM: "text-teal-400",
}

const categoryIcon: Record<ContactType, LucideIcon> = {
  Agent: UserCheck, Personal: User, Vendor: Wrench, Investor: TrendingUp,
  PrivateMoney: Banknote, Seller: Home, PM: Building2,
}

const VERDICT_BUTTON: Record<Verdict, { label: string; active: string }> = {
  keep:  { label: "Keep",  active: "bg-emerald-500/15 border-emerald-500/40 text-emerald-400" },
  vague: { label: "Vague", active: "bg-purple-500/15 border-purple-500/40 text-purple-400" },
  never: { label: "Never", active: "bg-red-500/15 border-red-500/40 text-red-400" },
}

const PAGE_SIZE = 150

function coerceType(t: unknown): ContactType {
  return ALL_TYPES.includes(t as ContactType) ? (t as ContactType) : "Agent"
}

export function CleanupMode({ onToast }: { onToast: (msg: string) => void }) {
  const [contacts, setContacts] = useState<CleanupContact[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [typeFilter, setTypeFilter] = useState<ContactType | "All">("All")
  const [hideReviewed, setHideReviewed] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/crms/cleanup", { cache: "no-store" })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setContacts((data.contacts || []).map((c: CleanupContact & { category?: string }) => ({
        ...c,
        type: coerceType(c.type ?? c.category),
      })))
    } catch {
      setError("Could not load the cleanup list — check the database connection.")
    } finally {
      setLoading(false)
    }
  }

  // Tapping the current verdict again = undo; anything else sets that verdict.
  async function handleVerdict(contact: CleanupContact, tapped: Verdict) {
    if (savingIds.has(contact.id)) return
    const verdict = contact.cleanupVerdict === tapped ? "undo" : tapped
    const prev = contact

    setSavingIds(s => new Set(s).add(contact.id))
    setContacts(cs => cs.map(c =>
      c.id === contact.id
        ? {
            ...c,
            cleanupVerdict: verdict === "undo" ? null : tapped,
            dnc: verdict === "never",
            tier: verdict === "vague" ? "D" : c.tier,
          }
        : c
    ))

    try {
      const res = await fetch("/api/crms/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: contact.id, verdict }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setContacts(cs => cs.map(c => (c.id === contact.id ? prev : c)))
      onToast(`Couldn't save ${contact.name} — try again`)
    } finally {
      setSavingIds(s => { const n = new Set(s); n.delete(contact.id); return n })
    }
  }

  const reviewed = useMemo(() => contacts.filter(c => c.cleanupVerdict).length, [contacts])

  const filtered = useMemo(() => contacts.filter(c => {
    if (typeFilter !== "All" && c.type !== typeFilter) return false
    if (hideReviewed && c.cleanupVerdict) return false
    return true
  }), [contacts, typeFilter, hideReviewed])

  const visible = filtered.slice(0, visibleCount)
  const progressPct = contacts.length > 0 ? Math.round((reviewed / contacts.length) * 100) : 0

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 gap-2">
        <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
        <span className="text-sm text-zinc-500">Loading full book…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-16 space-y-2">
        <p className="text-sm text-red-400">{error}</p>
        <button onClick={load} className="text-xs text-zinc-400 hover:text-zinc-200 underline">Retry</button>
      </div>
    )
  }

  return (
    <div className="space-y-3">

      {/* Progress */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-300 font-medium">{reviewed} reviewed</span>
          <span className="text-zinc-500">{contacts.length - reviewed} to go</span>
        </div>
        <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
          <div className="h-full bg-purple-500 transition-all" style={{ width: `${progressPct}%` }} />
        </div>
        <p className="text-xs text-zinc-600">
          Sorted by <span className="text-zinc-400 font-medium">avoidance</span> — skips + &ldquo;done&rdquo; clicks with no message sent
        </p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {(["All", ...ALL_TYPES] as (ContactType | "All")[]).map(t => (
          <button
            key={t}
            onClick={() => { setTypeFilter(t); setVisibleCount(PAGE_SIZE) }}
            className={`text-xs px-2.5 py-1.5 rounded border transition-colors ${
              typeFilter === t
                ? "bg-zinc-800 border-zinc-600 text-zinc-200"
                : "border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
            }`}
          >
            {t === "All" ? "All" : TYPE_LABEL[t]}
          </button>
        ))}
        <button
          onClick={() => { setHideReviewed(h => !h); setVisibleCount(PAGE_SIZE) }}
          className={`ml-auto text-xs px-2.5 py-1.5 rounded border transition-colors ${
            hideReviewed
              ? "bg-zinc-800 border-zinc-600 text-zinc-200"
              : "border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
          }`}
        >
          Hide reviewed
        </button>
      </div>

      {/* Contact rows */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800/70">
        {visible.length === 0 ? (
          <p className="text-xs text-zinc-600 px-3 py-4">
            {filtered.length === 0 && contacts.length > 0 ? "Nothing matches this filter" : "No contacts"}
          </p>
        ) : (
          visible.map(c => {
            const Icon = categoryIcon[c.type] ?? User
            const saving = savingIds.has(c.id)
            return (
              <div key={c.id} className={`px-3 py-2.5 space-y-2 ${c.dnc ? "opacity-60" : ""}`}>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={`text-xs font-bold px-1 py-0.5 rounded border leading-none shrink-0 ${tierStyle[c.tier] ?? tierStyle.C}`}>
                    {c.tier}
                  </span>
                  <Icon className={`w-3.5 h-3.5 shrink-0 ${categoryColor[c.type] ?? "text-zinc-400"}`} />
                  <span className={`text-xs font-medium truncate flex-1 min-w-0 ${c.dnc ? "text-zinc-500 line-through" : "text-zinc-200"}`}>
                    {c.name}
                  </span>
                  {c.skips > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border shrink-0 bg-yellow-500/10 border-yellow-500/30 text-yellow-400 leading-none">
                      skipped {c.skips}&times;
                    </span>
                  )}
                  {c.manualDones > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border shrink-0 bg-sky-500/10 border-sky-500/30 text-sky-400 leading-none">
                      done, no msg {c.manualDones}&times;
                    </span>
                  )}
                  <span className="text-xs text-zinc-600 shrink-0">{c.lastContact}</span>
                </div>
                <div className="flex gap-1.5">
                  {(Object.keys(VERDICT_BUTTON) as Verdict[]).map(v => (
                    <button
                      key={v}
                      onClick={() => handleVerdict(c, v)}
                      disabled={saving}
                      className={`flex-1 text-xs font-semibold py-2 rounded border transition-colors disabled:opacity-50 ${
                        c.cleanupVerdict === v
                          ? VERDICT_BUTTON[v].active
                          : "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
                      }`}
                    >
                      {VERDICT_BUTTON[v].label}
                    </button>
                  ))}
                </div>
                {c.cleanupVerdict === "never" && (
                  <p className="text-[11px] text-zinc-600">
                    <span className="text-red-400 font-medium">Do not contact</span> — out of rotation, kept in search
                  </p>
                )}
                {c.cleanupVerdict === "vague" && (
                  <p className="text-[11px] text-zinc-600">
                    <span className="text-purple-400 font-medium">&rarr; Tier D</span> — asleep for a year, then one light reintro
                  </p>
                )}
              </div>
            )
          })
        )}
      </div>

      {filtered.length > visibleCount && (
        <button
          onClick={() => setVisibleCount(n => n + PAGE_SIZE)}
          className="w-full text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-lg py-2.5 transition-colors"
        >
          Show more ({filtered.length - visibleCount} remaining)
        </button>
      )}
    </div>
  )
}
