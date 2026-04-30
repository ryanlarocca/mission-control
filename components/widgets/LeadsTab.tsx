"use client"

import { useEffect, useMemo, useState, useCallback } from "react"
import {
  Phone, PhoneOutgoing, Voicemail, MessageSquare, ClipboardList, ChevronDown, ChevronRight,
  Loader2, RefreshCw, Send, Check,
} from "lucide-react"

type LeadType = "call" | "voicemail" | "sms" | "form"
type LeadStatus = "new" | "hot" | "qualified" | "warm" | "junk" | "contacted"
type SourceType = "direct_mail" | "google_ads"

// See lib/leads.ts for the schema conventions:
//   `message` holds SMS body for sms rows, transcription for voicemail/call rows
//   `twilio_number IS NULL` means outbound (sent via iMessage sidecar)
//   `source_type` buckets the lead ('direct_mail' | 'google_ads') for filtering
interface Lead {
  id: string
  created_at: string
  source: string | null
  source_type: string | null
  twilio_number: string | null
  caller_phone: string | null
  lead_type: LeadType | null
  message: string | null
  recording_url: string | null
  status: LeadStatus
  notes: string | null
  ai_notes: string | null
  name: string | null
  email: string | null
  property_address: string | null
}

function isOutbound(l: Lead): boolean {
  return !l.twilio_number
}

interface LeadGroup {
  phone: string
  source: string | null
  sourceType: string | null
  status: LeadStatus
  notes: string | null
  aiNotes: string | null
  name: string | null
  email: string | null
  propertyAddress: string | null
  mostRecentId: string             // id of the row whose status drives the group
  mostRecentEvent: Lead             // for header display
  mostRecentInbound: Lead | null   // most recent INBOUND event (for source/contact info)
  events: Lead[]                    // all events, oldest → newest
  inboundCount: number
}

const STATUS_FILTERS: ({ key: "all" | LeadStatus; label: string })[] = [
  { key: "all",        label: "All" },
  { key: "new",        label: "New" },
  { key: "hot",        label: "Hot" },
  { key: "qualified",  label: "Qualified" },
  { key: "warm",       label: "Warm" },
  { key: "junk",       label: "Junk" },
  { key: "contacted",  label: "Contacted" },
]

const SOURCE_TYPE_FILTERS: ({ key: "all" | SourceType; label: string })[] = [
  { key: "all",          label: "All Sources" },
  { key: "direct_mail",  label: "Direct Mail" },
  { key: "google_ads",   label: "Google Ads" },
]

const STATUS_BADGE: Record<LeadStatus, string> = {
  new:        "bg-zinc-700 text-zinc-200",
  hot:        "bg-red-900/60 text-red-200",
  qualified:  "bg-emerald-900/60 text-emerald-200",
  warm:       "bg-amber-900/60 text-amber-200",
  junk:       "bg-zinc-800 text-zinc-500",
  contacted:  "bg-blue-900/60 text-blue-200",
}

const SOURCE_BADGE: Record<string, string> = {
  "MFM-A":      "bg-sky-900/60 text-sky-200",
  "MFM-B":      "bg-purple-900/60 text-purple-200",
  "Google Ads": "bg-green-900/60 text-green-200",
  Unknown:      "bg-zinc-800 text-zinc-400",
}

const SOURCE_TYPE_BADGE: Record<string, string> = {
  direct_mail: "bg-orange-900/60 text-orange-200",
  google_ads:  "bg-green-900/60 text-green-200",
}

const SOURCE_TYPE_LABEL: Record<string, string> = {
  direct_mail: "Direct Mail",
  google_ads:  "Google Ads",
}

const TYPE_ICON: Record<LeadType, typeof Phone> = {
  call:      Phone,
  voicemail: Voicemail,
  sms:       MessageSquare,
  form:      ClipboardList,
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

function groupLeads(leads: Lead[]): LeadGroup[] {
  const byPhone = new Map<string, Lead[]>()
  for (const l of leads) {
    const phone = l.caller_phone || ""
    if (!phone) continue
    const list = byPhone.get(phone) || []
    list.push(l)
    byPhone.set(phone, list)
  }

  const groups: LeadGroup[] = []
  for (const [phone, evs] of Array.from(byPhone.entries())) {
    // Sort oldest → newest for timeline display
    const ascending = [...evs].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )
    const newestFirst = [...ascending].reverse()
    const mostRecent = newestFirst[0]
    const mostRecentInbound = newestFirst.find(e => !isOutbound(e)) || null
    const inboundCount = ascending.filter(e => !isOutbound(e)).length
    // Status comes from the most recent inbound (if any) so an outbound
    // "contacted" insert doesn't clobber the existing inbound's status.
    const statusSource = mostRecentInbound || mostRecent
    // Take name/email/address from whichever event has them — the import
    // backfills these onto the oldest row, while live captures may add them
    // on a later row. First non-null wins.
    const name = ascending.map(e => e.name).find(v => v && v.trim()) || null
    const email = ascending.map(e => e.email).find(v => v && v.trim()) || null
    const propertyAddress = ascending.map(e => e.property_address).find(v => v && v.trim()) || null
    const aiNotes = newestFirst.map(e => e.ai_notes).find(v => v && v.trim()) || null
    groups.push({
      phone,
      source: (mostRecentInbound?.source) || mostRecent.source,
      sourceType: (mostRecentInbound?.source_type) || mostRecent.source_type,
      status: statusSource.status,
      notes: statusSource.notes,
      aiNotes,
      name,
      email,
      propertyAddress,
      mostRecentId: statusSource.id,
      mostRecentEvent: mostRecent,
      mostRecentInbound,
      events: ascending,
      inboundCount,
    })
  }
  // Sort groups by newest event first
  groups.sort(
    (a, b) =>
      new Date(b.mostRecentEvent.created_at).getTime() -
      new Date(a.mostRecentEvent.created_at).getTime()
  )
  return groups
}

export function LeadsTab() {
  const [leads, setLeads]               = useState<Lead[]>([])
  const [loading, setLoading]           = useState(true)
  const [refreshing, setRefreshing]     = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [filter, setFilter]             = useState<"all" | LeadStatus>("all")
  const [sourceFilter, setSourceFilter] = useState<"all" | SourceType>("all")
  const [expandedPhone, setExpandedPhone] = useState<string | null>(null)
  const [pendingStatus, setPendingStatus] = useState<string | null>(null)
  const [draftNotes, setDraftNotes]     = useState<Record<string, string>>({})
  const [draftMessage, setDraftMessage] = useState<Record<string, string>>({})
  const [sendingFor, setSendingFor]     = useState<string | null>(null)
  const [sendError, setSendError]       = useState<string | null>(null)
  const [sendSuccess, setSendSuccess]   = useState<string | null>(null)
  const [callingFor, setCallingFor]     = useState<string | null>(null)
  const [callError, setCallError]       = useState<string | null>(null)
  const [callSuccess, setCallSuccess]   = useState<string | null>(null)

  const fetchLeads = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true)
    try {
      const res = await fetch("/api/leads?limit=500", { cache: "no-store" })
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

  const groups = useMemo(() => groupLeads(leads), [leads])
  const filteredGroups = useMemo(() => {
    let result = groups
    if (filter !== "all") result = result.filter(g => g.status === filter)
    if (sourceFilter !== "all") result = result.filter(g => g.sourceType === sourceFilter)
    return result
  }, [groups, filter, sourceFilter])

  async function patchLead(id: string, update: { status?: LeadStatus; notes?: string }) {
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

  async function setGroupStatus(group: LeadGroup, status: LeadStatus) {
    setPendingStatus(group.phone + ":" + status)
    // Optimistic update: patch the row that drives status display
    setLeads(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, status } : l))
    await patchLead(group.mostRecentId, { status })
    setPendingStatus(null)
  }

  function startEditingNotes(group: LeadGroup) {
    if (draftNotes[group.phone] === undefined) {
      setDraftNotes(prev => ({ ...prev, [group.phone]: group.notes ?? "" }))
    }
  }

  function commitNotes(group: LeadGroup) {
    const val = draftNotes[group.phone]
    if (val === undefined) return
    if ((val || "") === (group.notes ?? "")) return
    // Optimistic
    setLeads(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, notes: val } : l))
    void patchLead(group.mostRecentId, { notes: val })
  }

  async function callLead(group: LeadGroup) {
    setCallingFor(group.phone)
    setCallError(null)
    try {
      const res = await fetch("/api/leads/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: group.phone,
          source: group.source,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setCallSuccess(group.phone)
      setTimeout(() => setCallSuccess(null), 4000)
      // Refetch to surface the new outbound call row in the timeline.
      void fetchLeads(true)
    } catch (e) {
      setCallError(e instanceof Error ? e.message : String(e))
    } finally {
      setCallingFor(null)
    }
  }

  async function sendOutbound(group: LeadGroup) {
    const text = (draftMessage[group.phone] || "").trim()
    if (!text) return
    setSendingFor(group.phone)
    setSendError(null)
    try {
      const res = await fetch("/api/leads/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: group.phone,
          message: text,
          source: group.source,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setDraftMessage(prev => ({ ...prev, [group.phone]: "" }))
      setSendSuccess(group.phone)
      setTimeout(() => setSendSuccess(null), 2500)
      // Refetch to pick up the new outbound row in the timeline
      void fetchLeads(true)
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e))
    } finally {
      setSendingFor(null)
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Leads</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            {loading ? "Loading…" : `${groups.length} leads · ${filteredGroups.length} shown`}
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

      <div className="mb-2 flex flex-wrap gap-1.5">
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
      <div className="mb-4 flex flex-wrap gap-1.5">
        {SOURCE_TYPE_FILTERS.map(({ key, label }) => {
          const active = sourceFilter === key
          return (
            <button
              key={key}
              onClick={() => setSourceFilter(key)}
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
      ) : filteredGroups.length === 0 ? (
        <div className="text-sm text-zinc-500 py-12 text-center">
          {groups.length === 0 ? "No leads yet." : `No ${filter} leads.`}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredGroups.map(group => (
            <LeadCard
              key={group.phone}
              group={group}
              expanded={expandedPhone === group.phone}
              onToggle={() => setExpandedPhone(expandedPhone === group.phone ? null : group.phone)}
              onSetStatus={(s) => setGroupStatus(group, s)}
              pendingStatus={pendingStatus}
              draftNote={draftNotes[group.phone]}
              onEditNote={(v) => setDraftNotes(prev => ({ ...prev, [group.phone]: v }))}
              onFocusNote={() => startEditingNotes(group)}
              onCommitNote={() => commitNotes(group)}
              draftMessage={draftMessage[group.phone] ?? ""}
              onEditMessage={(v) => setDraftMessage(prev => ({ ...prev, [group.phone]: v }))}
              onSend={() => sendOutbound(group)}
              sending={sendingFor === group.phone}
              sendError={sendingFor === null && sendError && expandedPhone === group.phone ? sendError : null}
              sendSuccess={sendSuccess === group.phone}
              onCall={() => callLead(group)}
              calling={callingFor === group.phone}
              callError={callingFor === null && callError && expandedPhone === group.phone ? callError : null}
              callSuccess={callSuccess === group.phone}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface LeadCardProps {
  group: LeadGroup
  expanded: boolean
  onToggle: () => void
  onSetStatus: (s: LeadStatus) => void
  pendingStatus: string | null
  draftNote: string | undefined
  onEditNote: (v: string) => void
  onFocusNote: () => void
  onCommitNote: () => void
  draftMessage: string
  onEditMessage: (v: string) => void
  onSend: () => void
  sending: boolean
  sendError: string | null
  sendSuccess: boolean
  onCall: () => void
  calling: boolean
  callError: string | null
  callSuccess: boolean
}

function LeadCard(p: LeadCardProps) {
  const { group, expanded } = p
  const Icon = TYPE_ICON[group.mostRecentEvent.lead_type ?? "call"] || Phone
  const sourceClass = SOURCE_BADGE[group.source || "Unknown"] || SOURCE_BADGE.Unknown
  const sourceTypeClass = group.sourceType ? SOURCE_TYPE_BADGE[group.sourceType] : null

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 overflow-hidden">
      <button
        onClick={p.onToggle}
        className="w-full px-3 py-3 flex items-center gap-3 text-left hover:bg-zinc-900/50 transition-colors"
      >
        <div className="flex flex-col gap-0.5 shrink-0">
          <span className={`px-2 py-0.5 text-[10px] font-semibold rounded uppercase tracking-wider ${sourceClass}`}>
            {group.source || "?"}
          </span>
          {sourceTypeClass && (
            <span className={`px-2 py-0.5 text-[9px] font-semibold rounded uppercase tracking-wider ${sourceTypeClass}`}>
              {SOURCE_TYPE_LABEL[group.sourceType!] || group.sourceType}
            </span>
          )}
        </div>
        <Icon className="w-4 h-4 text-zinc-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-zinc-100 font-medium truncate">
            {group.name || formatPhone(group.phone)}
          </div>
          {group.name && (
            <div className="text-xs text-zinc-500 truncate">{formatPhone(group.phone)}</div>
          )}
          <div className="text-xs text-zinc-500 truncate">
            {relativeTime(group.mostRecentEvent.created_at)}
            {group.events.length > 1 && ` · ${group.events.length} events`}
          </div>
        </div>
        <span className={`px-2 py-0.5 text-[10px] font-semibold rounded uppercase tracking-wider ${STATUS_BADGE[group.status]}`}>
          {group.status}
        </span>
        {expanded
          ? <ChevronDown className="w-4 h-4 text-zinc-600 shrink-0" />
          : <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t border-zinc-800 px-3 py-3 space-y-3">
          <div className="text-sm flex items-center gap-3 flex-wrap">
            <a
              href={`tel:${group.phone}`}
              className="inline-flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 underline-offset-2 hover:underline"
            >
              <Phone className="w-3.5 h-3.5" />
              {formatPhone(group.phone)}
            </a>
            <button
              onClick={p.onCall}
              disabled={p.calling}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
              title="Ring my cell, then bridge to this lead with recording"
            >
              {p.calling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PhoneOutgoing className="w-3.5 h-3.5" />}
              {p.calling ? "Dialing…" : "Call"}
            </button>
            {p.callSuccess && (
              <span className="text-emerald-400 text-xs inline-flex items-center gap-1">
                <Check className="w-3 h-3" /> Ringing your cell
              </span>
            )}
            {p.callError && (
              <span className="text-red-300 text-xs">{p.callError}</span>
            )}
            {group.email && (
              <span className="ml-auto text-zinc-400 text-xs">📧 {group.email}</span>
            )}
          </div>

          {group.propertyAddress && (
            <div className="text-xs text-zinc-400">
              <span className="text-zinc-500">🏠 </span>{group.propertyAddress}
            </div>
          )}

          <Timeline events={group.events} />

          {group.aiNotes && (
            <div className="bg-zinc-900/50 border border-zinc-800 rounded px-3 py-2">
              <div className="text-xs text-zinc-500 mb-1">🤖 AI Triage</div>
              <div className="text-sm text-zinc-200">{group.aiNotes}</div>
            </div>
          )}

          <div>
            <div className="text-xs text-zinc-500 mb-1.5">Notes</div>
            <textarea
              value={p.draftNote ?? group.notes ?? ""}
              onFocus={p.onFocusNote}
              onChange={e => p.onEditNote(e.target.value)}
              onBlur={p.onCommitNote}
              placeholder="Add notes…"
              rows={2}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 resize-none"
              style={{ fontSize: 16 }}
            />
          </div>

          <div>
            <div className="text-xs text-zinc-500 mb-1.5">Send a message</div>
            <textarea
              value={p.draftMessage}
              onChange={e => p.onEditMessage(e.target.value)}
              placeholder="Send a message…"
              rows={3}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 resize-none"
              style={{ fontSize: 16 }}
              disabled={p.sending}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="text-xs text-zinc-500 flex-1 min-w-0 truncate">
                {p.sendError && <span className="text-red-300">{p.sendError}</span>}
                {p.sendSuccess && (
                  <span className="text-emerald-400 inline-flex items-center gap-1">
                    <Check className="w-3 h-3" /> Sent
                  </span>
                )}
              </div>
              <button
                onClick={p.onSend}
                disabled={p.sending || !p.draftMessage.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium transition-colors"
              >
                {p.sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Send
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(["hot", "qualified", "warm", "contacted", "junk"] as LeadStatus[]).map(s => {
              const isCurrent = group.status === s
              const isPending = p.pendingStatus === group.phone + ":" + s
              return (
                <button
                  key={s}
                  onClick={() => p.onSetStatus(s)}
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
}

function Timeline({ events }: { events: Lead[] }) {
  return (
    <div className="space-y-2">
      <div className="text-xs text-zinc-500 mb-1.5">Timeline</div>
      {events.map(ev => (
        <TimelineEvent key={ev.id} ev={ev} />
      ))}
    </div>
  )
}

function TimelineEvent({ ev }: { ev: Lead }) {
  const outbound = isOutbound(ev)
  const Icon = TYPE_ICON[ev.lead_type ?? "call"] || Phone
  const fullTime = new Date(ev.created_at).toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  })

  if (outbound) {
    // Right-aligned bubble, emerald accent — Ryan's outbound message or call.
    // For outbound calls: show recording + transcription if attached, else
    // a placeholder so a fresh "ringing" call isn't rendered as "(empty)".
    const isOutboundCall = ev.lead_type === "call"
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-emerald-900/30 border border-emerald-900/50 rounded px-3 py-2 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-emerald-400/70 flex items-center gap-1.5">
            <span>You{isOutboundCall ? " · outbound call" : ""} · {fullTime}</span>
          </div>
          {isOutboundCall ? (
            <>
              {ev.message && (
                <div className="text-sm text-zinc-100 whitespace-pre-wrap break-words">
                  {ev.message}
                </div>
              )}
              {ev.recording_url && (
                <audio
                  controls
                  src={`/api/leads/recording-proxy?url=${encodeURIComponent(ev.recording_url)}`}
                  className="w-full"
                  preload="metadata"
                />
              )}
              {!ev.message && !ev.recording_url && (
                <div className="text-sm text-zinc-300 italic">Outbound call · awaiting recording</div>
              )}
            </>
          ) : (
            <div className="text-sm text-zinc-100 whitespace-pre-wrap break-words">
              {ev.message || "(empty)"}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-2.5">
      <div className="shrink-0 mt-0.5">
        <Icon className="w-4 h-4 text-zinc-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
          {(ev.lead_type ?? "event")} · {fullTime}
        </div>
        {ev.lead_type === "sms" && ev.message && (
          <div className="text-sm text-zinc-200 bg-zinc-900 rounded px-3 py-2 whitespace-pre-wrap break-words">
            {ev.message}
          </div>
        )}
        {ev.lead_type === "voicemail" && (
          <div className="space-y-2">
            {/* `message` holds the Whisper transcription for voicemail rows */}
            {ev.message && (
              <div className="text-sm text-zinc-200 bg-zinc-900 rounded px-3 py-2 whitespace-pre-wrap break-words">
                {ev.message}
              </div>
            )}
            {ev.recording_url && (
              <audio
                controls
                src={`/api/leads/recording-proxy?url=${encodeURIComponent(ev.recording_url)}`}
                className="w-full"
                preload="metadata"
              />
            )}
            {!ev.message && !ev.recording_url && (
              <div className="text-sm text-zinc-500 italic">Voicemail (no recording)</div>
            )}
          </div>
        )}
        {ev.lead_type === "call" && !ev.message && !ev.recording_url && (
          <div className="text-sm text-zinc-400 italic">Inbound call</div>
        )}
        {ev.lead_type === "call" && (ev.message || ev.recording_url) && (
          <div className="space-y-2">
            {ev.message && (
              <div className="text-sm text-zinc-200 bg-zinc-900 rounded px-3 py-2 whitespace-pre-wrap break-words">
                {ev.message}
              </div>
            )}
            {ev.recording_url && (
              <audio
                controls
                src={`/api/leads/recording-proxy?url=${encodeURIComponent(ev.recording_url)}`}
                className="w-full"
                preload="metadata"
              />
            )}
          </div>
        )}
        {ev.lead_type === "form" && (
          <div className="text-sm text-zinc-300 bg-zinc-900 rounded px-3 py-2">
            Website form submission
          </div>
        )}
      </div>
    </div>
  )
}
