"use client"

import { useEffect, useState, useCallback } from "react"
import {
  Phone, Voicemail, MessageSquare, ChevronDown, ChevronRight,
  Loader2, RefreshCw,
} from "lucide-react"

type LeadType = "call" | "voicemail" | "sms"
type LeadStatus = "new" | "hot" | "qualified" | "junk" | "contacted"

interface Lead {
  id: string
  created_at: string
  source: string | null
  twilio_number: string | null
  caller_phone: string | null
  lead_type: LeadType | null
  message: string | null
  recording_url: string | null
  status: LeadStatus
  notes: string | null
}

const STATUS_FILTERS: ({ key: "all" | LeadStatus; label: string })[] = [
  { key: "all",        label: "All" },
  { key: "new",        label: "New" },
  { key: "hot",        label: "Hot" },
  { key: "qualified",  label: "Qualified" },
  { key: "junk",       label: "Junk" },
  { key: "contacted",  label: "Contacted" },
]

const STATUS_BADGE: Record<LeadStatus, string> = {
  new:        "bg-zinc-700 text-zinc-200",
  hot:        "bg-red-900/60 text-red-200",
  qualified:  "bg-emerald-900/60 text-emerald-200",
  junk:       "bg-zinc-800 text-zinc-500",
  contacted:  "bg-blue-900/60 text-blue-200",
}

const SOURCE_BADGE: Record<string, string> = {
  "MFM-A":   "bg-sky-900/60 text-sky-200",
  "MFM-B":   "bg-purple-900/60 text-purple-200",
  Unknown:   "bg-zinc-800 text-zinc-400",
}

const TYPE_ICON: Record<LeadType, typeof Phone> = {
  call:      Phone,
  voicemail: Voicemail,
  sms:       MessageSquare,
}

function formatPhone(p: string | null | undefined): string {
  if (!p) return "—"
  const digits = p.replace(/\D/g, "")
  const last10 = digits.length > 10 ? digits.slice(-10) : digits
  if (last10.length !== 10) return p
  return `(${last10.slice(0,3)}) ${last10.slice(3,6)}-${last10.slice(6)}`
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const sec = Math.floor((now - then) / 1000)
  if (sec < 60)    return `${sec}s ago`
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" })
}

export function LeadsTab() {
  const [leads, setLeads]               = useState<Lead[]>([])
  const [loading, setLoading]           = useState(true)
  const [refreshing, setRefreshing]     = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [filter, setFilter]             = useState<"all" | LeadStatus>("all")
  const [expandedId, setExpandedId]     = useState<string | null>(null)
  const [pendingStatus, setPendingStatus] = useState<string | null>(null)
  const [draftNotes, setDraftNotes]     = useState<Record<string, string>>({})

  const fetchLeads = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true)
    try {
      const res = await fetch("/api/leads?limit=200", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setLeads(data.leads ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchLeads()
    const id = setInterval(() => fetchLeads(true), 30000)
    return () => clearInterval(id)
  }, [fetchLeads])

  async function updateLead(id: string, update: { status?: LeadStatus; notes?: string }) {
    // Optimistic update
    setLeads(prev => prev.map(l => l.id === id ? { ...l, ...update } : l))
    try {
      const res = await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...update }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error || `HTTP ${res.status}`)
      }
    } catch (e) {
      console.error("Update failed; refetching:", e)
      void fetchLeads(true)
    }
  }

  async function setStatus(id: string, status: LeadStatus) {
    setPendingStatus(id + ":" + status)
    await updateLead(id, { status })
    setPendingStatus(null)
  }

  function startEditingNotes(lead: Lead) {
    if (draftNotes[lead.id] === undefined) {
      setDraftNotes(prev => ({ ...prev, [lead.id]: lead.notes ?? "" }))
    }
  }

  function commitNotes(lead: Lead) {
    const val = draftNotes[lead.id]
    if (val === undefined) return
    if ((val || "") === (lead.notes ?? "")) return
    void updateLead(lead.id, { notes: val })
  }

  const filtered = filter === "all" ? leads : leads.filter(l => l.status === filter)

  return (
    <div>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Leads</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            {loading ? "Loading…" : `${leads.length} total · ${filtered.length} shown`}
          </p>
        </div>
        <button
          onClick={() => fetchLeads()}
          disabled={refreshing}
          className="p-2 -mr-2 text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Filter chips */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map(({ key, label }) => {
          const active = filter === key
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
                active
                  ? "bg-zinc-100 text-zinc-900 border-zinc-100"
                  : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-100 hover:border-zinc-700"
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-md bg-red-900/30 border border-red-900/50 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading leads…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-zinc-500 py-12 text-center">
          {leads.length === 0 ? "No leads yet." : `No ${filter} leads.`}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(lead => {
            const Icon = TYPE_ICON[lead.lead_type ?? "call"] || Phone
            const expanded = expandedId === lead.id
            const sourceClass = SOURCE_BADGE[lead.source || "Unknown"] || SOURCE_BADGE.Unknown
            return (
              <div
                key={lead.id}
                className="rounded-md border border-zinc-800 bg-zinc-950 overflow-hidden"
              >
                {/* Card header */}
                <button
                  onClick={() => setExpandedId(expanded ? null : lead.id)}
                  className="w-full px-3 py-3 flex items-center gap-3 text-left hover:bg-zinc-900/50 transition-colors"
                >
                  <span className={`px-2 py-0.5 text-[10px] font-semibold rounded uppercase tracking-wider ${sourceClass}`}>
                    {lead.source || "?"}
                  </span>
                  <Icon className="w-4 h-4 text-zinc-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-zinc-100 font-medium truncate">
                      {formatPhone(lead.caller_phone)}
                    </div>
                    <div className="text-xs text-zinc-500 truncate">
                      {relativeTime(lead.created_at)}
                      {lead.lead_type === "sms" && lead.message ? ` · "${lead.message.slice(0, 60)}${lead.message.length > 60 ? "…" : ""}"` : ""}
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 text-[10px] font-semibold rounded uppercase tracking-wider ${STATUS_BADGE[lead.status]}`}>
                    {lead.status}
                  </span>
                  {expanded
                    ? <ChevronDown className="w-4 h-4 text-zinc-600 shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />}
                </button>

                {/* Expanded detail */}
                {expanded && (
                  <div className="border-t border-zinc-800 px-3 py-3 space-y-3">
                    <div className="text-sm">
                      <a
                        href={`tel:${lead.caller_phone || ""}`}
                        className="inline-flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 underline-offset-2 hover:underline"
                      >
                        <Phone className="w-3.5 h-3.5" />
                        {formatPhone(lead.caller_phone)}
                      </a>
                    </div>

                    {lead.lead_type === "sms" && lead.message && (
                      <div className="text-sm text-zinc-200 bg-zinc-900 rounded px-3 py-2 whitespace-pre-wrap">
                        {lead.message}
                      </div>
                    )}

                    {lead.recording_url && (
                      <div>
                        <div className="text-xs text-zinc-500 mb-1.5">Voicemail</div>
                        <audio
                          controls
                          src={`/api/leads/recording-proxy?url=${encodeURIComponent(lead.recording_url)}`}
                          className="w-full"
                          preload="none"
                        />
                      </div>
                    )}

                    <div>
                      <div className="text-xs text-zinc-500 mb-1.5">Notes</div>
                      <textarea
                        value={draftNotes[lead.id] ?? lead.notes ?? ""}
                        onFocus={() => startEditingNotes(lead)}
                        onChange={e => setDraftNotes(prev => ({ ...prev, [lead.id]: e.target.value }))}
                        onBlur={() => commitNotes(lead)}
                        placeholder="Add notes…"
                        rows={2}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 resize-none"
                        style={{ fontSize: 16 }}
                      />
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {(["hot", "qualified", "contacted", "junk"] as LeadStatus[]).map(s => {
                        const isCurrent = lead.status === s
                        const isPending = pendingStatus === lead.id + ":" + s
                        return (
                          <button
                            key={s}
                            onClick={() => setStatus(lead.id, s)}
                            disabled={isCurrent || isPending}
                            className={`px-3 py-1.5 text-xs font-medium rounded border min-h-[36px] transition-colors ${
                              isCurrent
                                ? `${STATUS_BADGE[s]} border-transparent cursor-default`
                                : "bg-zinc-900 text-zinc-300 border-zinc-800 hover:text-zinc-100 hover:border-zinc-700"
                            } disabled:opacity-60`}
                          >
                            {isPending ? <Loader2 className="w-3 h-3 animate-spin inline" /> : s.charAt(0).toUpperCase() + s.slice(1)}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
