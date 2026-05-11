"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
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
//
// 2026-05-11 batch:
//   - "Anonymous" is filtered (Twilio's literal payload for blocked callers)
//     so it falls through to phone-number display.
//   - Cross-row name lookup: the follow-up row often has name=null but
//     another row for the same phone carries the real name. We POST a
//     batch query to /api/leads/names-by-phone and stitch the result in
//     for display only.
//   - Name/phone is now a click target → routes to /leads?phone=... so
//     Ryan can jump straight into the lead card.
//   - "Done" is hybrid: if a click-to-call fired in the last 60 min, we
//     trust the upcoming analyzeCallTranscript pass and clear silently.
//     Otherwise we open an inline interval picker (1w / 1mo / 3mo / 6mo /
//     None) — Ryan picks one and we PATCH the new date + reason. "None"
//     is the only path that clears recommended_followup_date to null.

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

// Twilio sends literal "Anonymous" for blocked callers. Treat it as
// missing so we fall through to phone-number display + so the cross-row
// name lookup runs for these rows.
function isUsableName(name: string | null | undefined): boolean {
  if (!name) return false
  const trimmed = name.trim()
  if (!trimmed) return false
  if (trimmed === "Anonymous") return false
  return true
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

// Interval picker options for the hybrid Done button. Done = "I handled
// this and want to set the next follow-up cadence" — the picker forces
// Ryan to pick a real interval rather than silently nulling the date.
// "No follow-up" is the only option that clears the field.
type IntervalKey = "1w" | "1mo" | "3mo" | "6mo" | "none"
interface IntervalOption {
  key: IntervalKey
  label: string
  addDays?: number
  addMonths?: number
}
const INTERVAL_OPTIONS: IntervalOption[] = [
  { key: "1w",   label: "1 week",   addDays: 7 },
  { key: "1mo",  label: "1 month",  addMonths: 1 },
  { key: "3mo",  label: "3 months", addMonths: 3 },
  { key: "6mo",  label: "6 months", addMonths: 6 },
  { key: "none", label: "No follow-up" },
]

// Local-timezone date math so the resulting YYYY-MM-DD lines up with
// what the rest of the tab renders (formatDate uses T00:00:00 local).
function todayLocal(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function dateFromInterval(opt: IntervalOption): string | null {
  if (opt.key === "none") return null
  const d = todayLocal()
  if (opt.addDays) d.setDate(d.getDate() + opt.addDays)
  if (opt.addMonths) d.setMonth(d.getMonth() + opt.addMonths)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

const RECENT_CALL_WINDOW_MIN = 60

export function FollowUpTab() {
  const router = useRouter()
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actingOn, setActingOn] = useState<string | null>(null)
  const [snoozeOpenFor, setSnoozeOpenFor] = useState<string | null>(null)
  const [intervalOpenFor, setIntervalOpenFor] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // Cross-row name stitch: phone → name pulled from any lead row that has
  // a usable name. Display-only — never written back.
  const [nameMap, setNameMap] = useState<Record<string, string>>({})

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
      const merged = Array.from(byKey.values()).sort((a, b) =>
        (a.recommended_followup_date || "").localeCompare(b.recommended_followup_date || "")
      )
      setLeads(merged)
      setError(null)

      // Cross-row name lookup. Collect every phone for follow-up rows
      // whose name is missing/Anonymous and POST one batch query. Skip
      // email-only rows (no phone → nothing to stitch).
      const phonesNeedingName = Array.from(new Set(
        merged
          .filter(l => l.caller_phone && !isUsableName(l.name))
          .map(l => l.caller_phone as string)
      ))
      if (phonesNeedingName.length > 0) {
        fetch("/api/leads/names-by-phone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phones: phonesNeedingName }),
        })
          .then(r => r.ok ? r.json() : { names: {} })
          .then((data: { names?: Record<string, string> }) => {
            if (data.names) setNameMap(prev => ({ ...prev, ...data.names }))
          })
          .catch(() => { /* silent — display name fallback handles it */ })
      }
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

  // Resolve the display name for a lead: prefer the row's own name (if
  // usable), then the cross-row stitched value, then null (which lets
  // the row fall through to phone/email display).
  function displayName(lead: Lead): string | null {
    if (isUsableName(lead.name)) return lead.name
    if (lead.caller_phone && nameMap[lead.caller_phone]) return nameMap[lead.caller_phone]
    return null
  }

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

  // Hybrid Done: if the lead has a real recent call (within 60 min) we
  // trust the upcoming analyzeCallTranscript pass to set the next date —
  // clear the current recommendation and toast. Otherwise open the inline
  // interval picker so Ryan can pick the next cadence. NEVER null the
  // date without (a) a detected recent call OR (b) explicit "No follow-up".
  async function handleDone(lead: Lead) {
    if (!lead.caller_phone) {
      // Email-only row: no recent-call detection possible, go straight
      // to the interval picker.
      setIntervalOpenFor(prev => prev === lead.id ? null : lead.id)
      return
    }
    setActingOn(lead.id)
    try {
      const res = await fetch("/api/leads/recent-call-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: lead.caller_phone,
          windowMinutes: RECENT_CALL_WINDOW_MIN,
        }),
      })
      const data = await res.json().catch(() => ({ hasRecent: false })) as { hasRecent?: boolean }
      if (data.hasRecent) {
        await clearFollowupOnly(lead)
        showToast("Logged — AI will set your next follow-up")
        return
      }
      // No recent call → open the interval picker (don't touch DB yet).
      setIntervalOpenFor(prev => prev === lead.id ? null : lead.id)
    } finally {
      setActingOn(null)
    }
  }

  function showToast(text: string) {
    setToast(text)
    window.setTimeout(() => setToast(prev => prev === text ? null : prev), 3500)
  }

  // Clear the recommendation (date + reason both null). Used by the
  // recent-call branch of Done and by the "No follow-up" interval pick.
  async function clearFollowupOnly(lead: Lead) {
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
    }
  }

  // Apply an interval picker selection. "none" clears the date; everything
  // else PATCHes a new recommended_followup_date + a "Manual — <label>"
  // reason so the follow-up banner has something to render.
  async function applyInterval(lead: Lead, opt: IntervalOption) {
    setIntervalOpenFor(null)
    if (opt.key === "none") {
      await clearFollowupOnly(lead)
      return
    }
    const newDate = dateFromInterval(opt)
    if (!newDate) return
    const reason = `Manual — ${opt.label}`
    setActingOn(lead.id)
    // Optimistic: drop the lead from the visible list since the new date
    // is in the future (we'd otherwise wait for the next 60s refetch to
    // re-bucket it).
    setLeads(prev => prev.filter(l => l.id !== lead.id))
    try {
      const res = await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: lead.id,
          recommended_followup_date: newDate,
          followup_reason: reason,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      // Pull the lead back if it now belongs in a later bucket.
      void fetchFollowups(true)
    } catch (e) {
      console.error("interval pick failed:", e)
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

  // Tap name/phone → jump into the Leads tab with the matching card
  // pre-expanded. Email-only rows (no phone) get rendered non-clickable
  // since the Leads tab doesn't currently support ?email= as a deeplink.
  function openInLeadsTab(lead: Lead) {
    if (!lead.caller_phone) return
    router.push(`/leads?phone=${encodeURIComponent(lead.caller_phone)}`)
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

      {toast && (
        <div className="mb-3 px-3 py-2 rounded-md bg-emerald-900/30 border border-emerald-900/50 text-sm text-emerald-200">
          {toast}
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
                      displayName={displayName(lead)}
                      acting={actingOn === lead.id}
                      snoozeOpen={snoozeOpenFor === lead.id}
                      intervalOpen={intervalOpenFor === lead.id}
                      onToggleSnooze={() => setSnoozeOpenFor(prev => prev === lead.id ? null : lead.id)}
                      onCall={() => callLead(lead)}
                      onDone={() => handleDone(lead)}
                      onSnooze={(d) => snooze(lead, d)}
                      onPickInterval={(opt) => applyInterval(lead, opt)}
                      onOpenInLeads={() => openInLeadsTab(lead)}
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
  displayName: string | null
  acting: boolean
  snoozeOpen: boolean
  intervalOpen: boolean
  onToggleSnooze: () => void
  onCall: () => void
  onDone: () => void
  onSnooze: (days: number) => void
  onPickInterval: (opt: IntervalOption) => void
  onOpenInLeads: () => void
}) {
  const { lead, displayName, acting, snoozeOpen, intervalOpen } = props
  const phoneDisplay = lead.caller_phone ? formatPhone(lead.caller_phone) : null
  const headline = displayName || phoneDisplay || lead.email || "(unknown)"
  // Sub line shows phone OR email only when the headline already took
  // the name slot (otherwise the headline IS the phone/email).
  const subLine = displayName ? (phoneDisplay || lead.email || null) : null
  const canOpenInLeads = !!lead.caller_phone

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="shrink-0 text-xs text-zinc-500 inline-flex items-center gap-1 pt-0.5">
          <Clock className="w-3 h-3" />
          {formatDate(lead.recommended_followup_date!)}
        </div>
        <div className="flex-1 min-w-0">
          {canOpenInLeads ? (
            <button
              type="button"
              onClick={props.onOpenInLeads}
              className="block w-full text-left group focus:outline-none"
            >
              <div className="text-sm text-zinc-100 font-medium truncate group-hover:underline">
                {headline}
              </div>
              {subLine && (
                <div className="text-xs text-zinc-500 truncate group-hover:text-zinc-400">
                  {subLine}
                </div>
              )}
            </button>
          ) : (
            <>
              <div className="text-sm text-zinc-100 font-medium truncate">{headline}</div>
              {subLine && <div className="text-xs text-zinc-500 truncate">{subLine}</div>}
            </>
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
      {intervalOpen && (
        <div className="mt-3 pt-3 border-t border-zinc-800">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
            Set next follow-up
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {INTERVAL_OPTIONS.map(opt => (
              <button
                key={opt.key}
                onClick={() => props.onPickInterval(opt)}
                disabled={acting}
                className={`inline-flex items-center px-3 py-1.5 min-h-[32px] rounded-full text-xs font-medium transition-colors ${
                  opt.key === "none"
                    ? "bg-zinc-900 border border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                    : "bg-emerald-900/40 border border-emerald-900/60 text-emerald-200 hover:bg-emerald-900/60"
                } disabled:opacity-50`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
