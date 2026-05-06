"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  PhoneOutgoing, Loader2, RefreshCw, Check, ChevronDown, Calendar, Clock,
} from "lucide-react"

// Phase 7C — Part 5: a flat to-do list of leads with a recommended
// follow-up date. Sorted by date ASC, grouped into Overdue / Today /
// This week / Later. Each row has Call (kicks the existing outbound
// call flow), Done (clears the recommendation), and Snooze (push +1d
// / +3d / +1w).
//
// Drip relationship: this tab only RECOMMENDS — it doesn't pause drip.
// But making the call (via the Call button) inserts an outbound row,
// which the drip engine treats as an activity → 14-day cool-off naturally
// kicks in. The Done button is for the case where Ryan handled the
// follow-up some other way (text, email) and just wants to clear it.

interface Lead {
  id: string
  created_at: string
  name: string | null
  caller_phone: string | null
  email: string | null
  source: string | null
  campaign_label: string | null
  property_address: string | null
  status: string
  recommended_followup_date: string | null
  followup_reason: string | null
  notes: string | null
  is_dnc?: boolean | null
  is_junk?: boolean | null
}

type Bucket = "overdue" | "today" | "week" | "later"

const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "This week",
  later: "Later",
}

function bucketFor(dateStr: string): Bucket {
  const d = new Date(dateStr + "T00:00:00")
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const weekFromNow = new Date(today)
  weekFromNow.setDate(weekFromNow.getDate() + 7)

  if (d < today) return "overdue"
  if (d < tomorrow) return "today"
  if (d < weekFromNow) return "week"
  return "later"
}

function formatPhone(p: string | null | undefined): string {
  if (!p) return ""
  const digits = p.replace(/\D/g, "")
  const last10 = digits.length > 10 ? digits.slice(-10) : digits
  if (last10.length !== 10) return p
  return `(${last10.slice(0, 3)}) ${last10.slice(3, 6)}-${last10.slice(6)}`
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00")
  return d.toLocaleDateString([], { month: "short", day: "numeric", weekday: "short" })
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00")
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export function FollowUpTab() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actingOn, setActingOn] = useState<string | null>(null)
  const [snoozeOpenFor, setSnoozeOpenFor] = useState<string | null>(null)

  const fetchFollowups = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true)
    try {
      const res = await fetch(
        "/api/leads?has_followup=true&sort=followup_date_asc&limit=300",
        { cache: "no-store" }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { leads: Lead[] }
      // Keep only one row per contact (the one with the freshest followup
      // date). Multiple rows can share a phone/email when an inbound and
      // an outbound landed under the same lead — both might carry follow-up
      // suggestions but Ryan only wants one to-do per person.
      const byKey = new Map<string, Lead>()
      for (const l of (data.leads || []).filter(l => l.recommended_followup_date && !l.is_dnc && !l.is_junk)) {
        const key = l.caller_phone || (l.email ? `email:${l.email.toLowerCase()}` : `id:${l.id}`)
        const existing = byKey.get(key)
        if (!existing || (l.recommended_followup_date! < (existing.recommended_followup_date || "9999-12-31"))) {
          byKey.set(key, l)
        }
      }
      setLeads(Array.from(byKey.values()).sort((a, b) =>
        (a.recommended_followup_date || "").localeCompare(b.recommended_followup_date || "")
      ))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void fetchFollowups()
    const id = setInterval(() => void fetchFollowups(true), 60000)
    return () => clearInterval(id)
  }, [fetchFollowups])

  const grouped = useMemo(() => {
    const groups: Record<Bucket, Lead[]> = { overdue: [], today: [], week: [], later: [] }
    for (const l of leads) {
      if (!l.recommended_followup_date) continue
      groups[bucketFor(l.recommended_followup_date)].push(l)
    }
    return groups
  }, [leads])

  async function callLead(lead: Lead) {
    if (!lead.caller_phone) return
    setActingOn(lead.id)
    try {
      const res = await fetch("/api/leads/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: lead.caller_phone, source: lead.source }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      // Don't auto-clear — Ryan may want to keep the to-do until the call
      // actually happened. The drip engine's HOLD logic picks up the new
      // outbound row separately.
    } catch (e) {
      alert(`Call failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setActingOn(null)
    }
  }

  async function clearFollowup(lead: Lead) {
    setActingOn(lead.id)
    setLeads(prev => prev.filter(l => l.id !== lead.id))
    try {
      const res = await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: lead.id,
          recommended_followup_date: null,
          followup_reason: null,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
    } catch (e) {
      console.error("clear followup failed:", e)
      void fetchFollowups(true)
    } finally {
      setActingOn(null)
    }
  }

  async function snooze(lead: Lead, days: number) {
    if (!lead.recommended_followup_date) return
    const newDate = addDays(lead.recommended_followup_date, days)
    setActingOn(lead.id)
    setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, recommended_followup_date: newDate } : l))
    setSnoozeOpenFor(null)
    try {
      const res = await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, recommended_followup_date: newDate }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      void fetchFollowups(true)
    } catch (e) {
      console.error("snooze failed:", e)
      void fetchFollowups(true)
    } finally {
      setActingOn(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-500 py-12">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading follow-ups…
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-100 inline-flex items-center gap-2">
            <Calendar className="w-4 h-4" /> Follow-ups
          </h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            {leads.length === 0 ? "Nothing to follow up on." : `${leads.length} lead${leads.length === 1 ? "" : "s"} to follow up on`}
          </p>
        </div>
        <button
          onClick={() => fetchFollowups()}
          disabled={refreshing}
          className="p-2 -mr-2 text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-md bg-red-900/30 border border-red-900/50 text-sm text-red-200">
          {error}
        </div>
      )}

      {leads.length === 0 ? (
        <div className="text-sm text-zinc-500 py-12 text-center">
          No follow-ups recommended. AI will surface these as it analyzes call transcripts.
        </div>
      ) : (
        <div className="space-y-4">
          {(["overdue", "today", "week", "later"] as Bucket[]).map(bucket => {
            const items = grouped[bucket]
            if (items.length === 0) return null
            return (
              <section key={bucket}>
                <h3 className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                  bucket === "overdue" ? "text-red-400"
                    : bucket === "today" ? "text-amber-400"
                    : "text-zinc-500"
                }`}>
                  {BUCKET_LABEL[bucket]} · {items.length}
                </h3>
                <div className="space-y-2">
                  {items.map(lead => (
                    <FollowUpRow
                      key={lead.id}
                      lead={lead}
                      acting={actingOn === lead.id}
                      snoozeOpen={snoozeOpenFor === lead.id}
                      onToggleSnooze={() => setSnoozeOpenFor(prev => prev === lead.id ? null : lead.id)}
                      onCall={() => callLead(lead)}
                      onDone={() => clearFollowup(lead)}
                      onSnooze={(d) => snooze(lead, d)}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FollowUpRow(props: {
  lead: Lead
  acting: boolean
  snoozeOpen: boolean
  onToggleSnooze: () => void
  onCall: () => void
  onDone: () => void
  onSnooze: (days: number) => void
}) {
  const { lead, acting, snoozeOpen } = props
  const phoneDisplay = lead.caller_phone ? formatPhone(lead.caller_phone) : null

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="shrink-0 text-xs text-zinc-500 inline-flex items-center gap-1 pt-0.5">
          <Clock className="w-3 h-3" />
          {formatDate(lead.recommended_followup_date!)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-zinc-100 font-medium truncate">
            {lead.name || phoneDisplay || lead.email || "(unknown)"}
          </div>
          {(phoneDisplay || lead.email) && (
            <div className="text-xs text-zinc-500 truncate">
              {phoneDisplay || lead.email}
            </div>
          )}
          {lead.property_address && (
            <div className="text-xs text-zinc-400 truncate">🏠 {lead.property_address}</div>
          )}
          {lead.followup_reason && (
            <div className="text-xs text-zinc-400 mt-1 italic">{lead.followup_reason}</div>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-1.5 flex-wrap">
        {lead.caller_phone && (
          <button
            onClick={props.onCall}
            disabled={acting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 text-white text-xs font-medium transition-colors"
          >
            {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PhoneOutgoing className="w-3.5 h-3.5" />}
            Call
          </button>
        )}
        <button
          onClick={props.onDone}
          disabled={acting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:text-zinc-100 text-zinc-400 text-xs font-medium transition-colors"
        >
          {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          Done
        </button>
        <div className="relative">
          <button
            onClick={props.onToggleSnooze}
            disabled={acting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:text-zinc-100 text-zinc-400 text-xs font-medium transition-colors"
          >
            Snooze
            <ChevronDown className="w-3 h-3" />
          </button>
          {snoozeOpen && (
            <div className="absolute right-0 top-full mt-1 z-10 rounded border border-zinc-800 bg-zinc-950 shadow-lg overflow-hidden">
              {[1, 3, 7].map(d => (
                <button
                  key={d}
                  onClick={() => props.onSnooze(d)}
                  className="block w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-900"
                >
                  +{d} day{d === 1 ? "" : "s"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
