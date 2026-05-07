"use client"

import { useEffect, useMemo, useState, useCallback } from "react"
import {
  Phone, PhoneOutgoing, Voicemail, MessageSquare, ClipboardList, ChevronDown, ChevronRight,
  Loader2, RefreshCw, Send, Check, Mail, Trash2, Bot, Clock, X,
  Sparkles, PhoneOff, Ban, ShieldOff, Zap, Wand2, Calendar, Pencil,
} from "lucide-react"
import { getCampaign, getNextTouch } from "@/lib/drip-campaigns"

type LeadType =
  | "call" | "voicemail" | "sms" | "form" | "email"
  | "drip_imessage" | "drip_email"
// Phase 7C lifecycle. Old statuses (qualified/junk/unqualified/do_not_contact)
// were remapped at migration time and are no longer accepted.
type LeadStatus =
  | "new" | "contacted" | "active" | "hot" | "warm" | "nurture" | "dead"
type SourceType = "direct_mail" | "google_ads"

interface DripQueueItem {
  id: string
  lead_id: string
  touch_number: number
  campaign_type: string
  channel: "imessage" | "email"
  message: string
  subject: string | null
  status: "pending" | "approved" | "skipped" | "sent" | "failed"
  created_at: string
}

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
  suggested_reply: string | null
  // Set on email leads at insertion (route.ts) so /api/leads/sync-email can
  // look up the full Gmail thread on card expand. Null on call/sms/form rows.
  gmail_thread_id?: string | null
  drip_campaign_type?: string | null
  drip_touch_number?: number | null
  last_drip_sent_at?: string | null
  // Phase 7C
  is_dnc?: boolean | null
  is_junk?: boolean | null
  is_bad_number?: boolean | null
  ai_summary?: string | null
  ai_summary_generated_at?: string | null
  recommended_followup_date?: string | null
  followup_reason?: string | null
  followup_generated_at?: string | null
  suggested_status?: LeadStatus | null
  suggested_status_reason?: string | null
  campaign_label?: string | null
}

// chat.db stores timestamps in Apple epoch (seconds since 2001-01-01); the
// sidecar returns them in Apple-epoch milliseconds. Convert to Unix epoch ms
// so JS Date() renders correctly.
const APPLE_EPOCH_OFFSET_MS = 978307200000

interface SyntheticIMessage {
  timestamp: number   // Apple-epoch ms (sidecar returns this)
  is_from_me: boolean
  text: string
}

interface SyntheticGmail {
  messageId: string | null
  from: string
  to: string
  subject: string
  body: string
  timestamp: number   // Unix epoch ms
  is_from_ryan: boolean
}

function isOutbound(l: Lead): boolean {
  return !l.twilio_number
}

interface LeadGroup {
  phone: string                     // grouping key — phone if present, else "email:<addr>"
  contactPhone: string | null       // actual phone (null for email-only leads)
  source: string | null
  sourceType: string | null
  status: LeadStatus
  notes: string | null
  aiNotes: string | null
  suggestedReply: string | null
  name: string | null
  email: string | null
  propertyAddress: string | null
  mostRecentId: string             // id of the row whose status drives the group
  mostRecentEvent: Lead             // for header display
  mostRecentInbound: Lead | null   // most recent INBOUND event (for source/contact info)
  events: Lead[]                    // all events, oldest → newest
  inboundCount: number
  // Phase 7C derived/copied fields. Flags + intelligence fields live on the
  // status-driving row (the lead's "primary" row). Drip metadata lives on
  // the original intake row (kept on the existing nextDripETA path).
  isDnc: boolean
  isJunk: boolean
  isBadNumber: boolean
  campaignLabel: string | null
  aiSummary: string | null
  aiSummaryAt: string | null
  recommendedFollowupDate: string | null
  followupReason: string | null
  suggestedStatus: LeadStatus | null
  suggestedStatusReason: string | null
}

// Lifecycle filters. DNC / Junk are flag-based filters, prefixed with
// "flag:" so they collide-free with lifecycle keys.
type FilterKey = "all" | LeadStatus | "flag:dnc" | "flag:junk" | "flag:bad_number"
const STATUS_FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all",             label: "All" },
  { key: "new",             label: "New" },
  { key: "contacted",       label: "Contacted" },
  { key: "active",          label: "Active" },
  { key: "hot",             label: "Hot" },
  { key: "warm",            label: "Warm" },
  { key: "nurture",         label: "Nurture" },
  { key: "dead",            label: "Dead" },
  { key: "flag:dnc",        label: "DNC" },
  { key: "flag:junk",       label: "Junk" },
  { key: "flag:bad_number", label: "Bad #" },
]

const SOURCE_TYPE_FILTERS: ({ key: "all" | SourceType; label: string })[] = [
  { key: "all",          label: "All Sources" },
  { key: "direct_mail",  label: "Direct Mail" },
  { key: "google_ads",   label: "Google Ads" },
]

const STATUS_BADGE: Record<LeadStatus, string> = {
  new:        "bg-zinc-700 text-zinc-200",
  contacted:  "bg-blue-900/60 text-blue-200",
  active:     "bg-sky-900/60 text-sky-200",
  hot:        "bg-red-900/60 text-red-200",
  warm:       "bg-amber-900/60 text-amber-200",
  nurture:    "bg-emerald-900/60 text-emerald-200",
  dead:       "bg-zinc-800 text-zinc-500",
}

const SOURCE_BADGE: Record<string, string> = {
  "MFM-A":      "bg-sky-900/60 text-sky-200",
  "MFM-B":      "bg-purple-900/60 text-purple-200",
  // Email-campaign mailers share buckets with their phone-number siblings,
  // so SVG-A matches MFM-A's color and SVJ-B matches MFM-B's.
  "SVG-A":      "bg-sky-900/60 text-sky-200",
  "SVJ-B":      "bg-purple-900/60 text-purple-200",
  "Google Ads": "bg-green-900/60 text-green-200",
  "DM-Legacy":  "bg-zinc-700 text-zinc-300",
  "Website":    "bg-violet-900/60 text-violet-200",
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
  call:          Phone,
  voicemail:     Voicemail,
  sms:           MessageSquare,
  form:          ClipboardList,
  email:         Mail,
  drip_imessage: Bot,
  drip_email:    Bot,
}

const STATUS_LABEL: Record<LeadStatus, string> = {
  new:        "New",
  contacted:  "Contacted",
  active:     "Active",
  hot:        "Hot",
  warm:       "Warm",
  nurture:    "Nurture",
  dead:       "Dead",
}

function formatPhone(p: string | null | undefined): string {
  if (!p) return "—"
  const digits = p.replace(/\D/g, "")
  const last10 = digits.length > 10 ? digits.slice(-10) : digits
  if (last10.length !== 10) return p
  return `(${last10.slice(0,3)}) ${last10.slice(3,6)}-${last10.slice(6)}`
}

// Predict when the drip engine will fire the next touch on a group.
// Returns null when the lead has no campaign assigned, has no remaining
// touches, sits in a stop-status (active/dead), or carries a hard-stop
// flag (DNC/Junk). The engine itself enforces all the same rules; this
// is a UI-only hint.
function nextDripETA(group: LeadGroup): string | null {
  const stopStatuses: LeadStatus[] = ["active", "dead"]
  if (stopStatuses.includes(group.status)) return null
  if (group.isDnc || group.isJunk) return null
  // Drip metadata lives on the original intake row (stamped on insert).
  const intake = group.events.find(e => e.drip_campaign_type) || group.events[0]
  if (!intake?.drip_campaign_type) return null
  const campaign = getCampaign(intake.drip_campaign_type)
  if (!campaign) return null
  const next = getNextTouch(campaign, intake.drip_touch_number ?? 0)
  if (!next) return null
  const lastSent = intake.last_drip_sent_at
    ? new Date(intake.last_drip_sent_at).getTime()
    : new Date(intake.created_at).getTime()
  const dueAt = lastSent + next.delayHours * 3600 * 1000
  const ms = dueAt - Date.now()
  const channel = next.channel === "email" ? "email" : "iMessage"
  if (ms <= 0) return `due now (touch #${next.touchNumber} ${channel})`
  const hours = Math.floor(ms / 3600000)
  if (hours < 24) return `in ${hours}h (touch #${next.touchNumber} ${channel})`
  const days = Math.floor(hours / 24)
  const rem = hours - days * 24
  return `in ${days}d ${rem}h (touch #${next.touchNumber} ${channel})`
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
  const byKey = new Map<string, Lead[]>()
  for (const l of leads) {
    // Phone wins whenever it's set — that's the strongest contact identity
    // we have. Even for email leads (e.g. Google Voice forwarded voicemails
    // with the caller's number in the body), a known phone means subsequent
    // outbound calls/SMS to that number should land in the same card. The
    // older "thread-id wins for emails" rule was added in Phase 7.4 to keep
    // multi-email Gmail threads from splitting on phone-number corrections,
    // but it had the side effect of orphaning email leads from any
    // phone-channel events on the same caller.
    //
    // Fallback chain when there's no phone: gmail thread → email → row id.
    // Email-only Gmail threads (no phone ever attached) still group by
    // thread, preserving the Phase 7.4 intent for that case.
    let key: string
    if (l.caller_phone) {
      key = l.caller_phone
    } else if (l.lead_type === "email" && l.gmail_thread_id) {
      key = `thread:${l.gmail_thread_id}`
    } else if (l.email) {
      key = `email:${l.email.toLowerCase()}`
    } else {
      key = `id:${l.id}`
    }
    const list = byKey.get(key) || []
    list.push(l)
    byKey.set(key, list)
  }

  const groups: LeadGroup[] = []
  for (const [key, evs] of Array.from(byKey.entries())) {
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
    // Suggested reply travels with the email row that produced it. Take the
    // newest non-null one so a follow-up email's draft replaces a stale one.
    const suggestedReply = newestFirst.map(e => e.suggested_reply).find(v => v && v.trim()) || null
    // Pick the LATEST inbound non-null phone so corrections in a Gmail
    // thread ("sorry my real number is X") override earlier guesses. Falls
    // back to the oldest non-null phone (any direction) for safety.
    const contactPhone =
      newestFirst.filter(e => !isOutbound(e)).map(e => e.caller_phone).find(v => v && v.trim()) ||
      ascending.map(e => e.caller_phone).find(v => v && v.trim()) ||
      null
    // Phase 7C — derive flags + intelligence fields. Flags live on the
    // status-driving row (manual updates target that row's id). AI summary
    // and follow-up come from whichever row in the group has them; if
    // multiple rows somehow have summaries, take the freshest.
    const isDnc = !!statusSource.is_dnc
    const isJunk = !!statusSource.is_junk
    const isBadNumber = !!statusSource.is_bad_number
    const campaignLabel =
      ascending.map(e => e.campaign_label).find(v => v && v.trim()) || null
    const aiSummaryRow = newestFirst
      .filter(e => e.ai_summary && e.ai_summary_generated_at)
      .sort((a, b) =>
        new Date(b.ai_summary_generated_at || 0).getTime() -
        new Date(a.ai_summary_generated_at || 0).getTime()
      )[0]
    const followupRow = newestFirst.find(e => e.recommended_followup_date)
    const suggestedRow = newestFirst.find(e => e.suggested_status)
    groups.push({
      phone: key,
      contactPhone,
      source: (mostRecentInbound?.source) || mostRecent.source,
      sourceType: (mostRecentInbound?.source_type) || mostRecent.source_type,
      status: statusSource.status,
      notes: statusSource.notes,
      aiNotes,
      suggestedReply,
      name,
      email,
      propertyAddress,
      mostRecentId: statusSource.id,
      mostRecentEvent: mostRecent,
      mostRecentInbound,
      events: ascending,
      inboundCount,
      isDnc,
      isJunk,
      isBadNumber,
      campaignLabel,
      aiSummary: aiSummaryRow?.ai_summary || null,
      aiSummaryAt: aiSummaryRow?.ai_summary_generated_at || null,
      recommendedFollowupDate: followupRow?.recommended_followup_date || null,
      followupReason: followupRow?.followup_reason || null,
      suggestedStatus: (suggestedRow?.suggested_status as LeadStatus | null) || null,
      suggestedStatusReason: suggestedRow?.suggested_status_reason || null,
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
  const [filter, setFilter]             = useState<FilterKey>("all")
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set())
  const [bulkApplying, setBulkApplying] = useState(false)
  const [bulkResult, setBulkResult]     = useState<string | null>(null)
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
  const [phoneDraft, setPhoneDraft]     = useState<Record<string, string>>({})
  const [savingPhoneFor, setSavingPhoneFor] = useState<string | null>(null)
  const [phoneError, setPhoneError]     = useState<string | null>(null)
  const [emailDraft, setEmailDraft]     = useState<Record<string, string>>({})
  const [sendingEmailFor, setSendingEmailFor] = useState<string | null>(null)
  const [emailSendSuccess, setEmailSendSuccess] = useState<string | null>(null)
  const [emailSendError, setEmailSendError] = useState<string | null>(null)
  const [deleteArmedFor, setDeleteArmedFor] = useState<string | null>(null)
  const [deletingFor, setDeletingFor] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Synthetic timeline rows merged in from chat.db (sync-imessage) and
  // Gmail threads (sync-email) when Ryan expands a card. Keyed by group.phone.
  // Kept separate from the leads state so they don't perturb status/grouping.
  const [extraEvents, setExtraEvents]   = useState<Record<string, Lead[]>>({})
  const [syncedGroups, setSyncedGroups] = useState<Set<string>>(new Set())
  // Phase 7C — Part 3: per-group AI summary state. Keyed by group.phone so
  // collapsing/re-expanding doesn't refetch unless cache is invalidated.
  const [summaries, setSummaries] = useState<Record<string, { text: string; loading: boolean; error: string | null }>>({})
  // Phase 7C — Part 7: per-card "drafting" loading state. Keyed
  // `${group.phone}:${channel}` so iMessage and email drafts spin
  // independently if Ryan triggers both in quick succession.
  const [draftingFor, setDraftingFor] = useState<string | null>(null)
  const [draftError, setDraftError]   = useState<string | null>(null)

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
  // Phase 7C — Part 8: keep the currently-expanded card visible regardless of
  // active filter. Without this, placing a call flips a cold lead's status
  // from "new" → "contacted" (auto-advance on first outbound), which then
  // filters the card out from under Ryan mid-call. Pin it instead.
  const filteredGroups = useMemo(() => {
    let result = groups
    if (filter === "flag:dnc") result = result.filter(g => g.isDnc)
    else if (filter === "flag:junk") result = result.filter(g => g.isJunk)
    else if (filter === "flag:bad_number") result = result.filter(g => g.isBadNumber)
    else if (filter !== "all") {
      // Hide DNC/Junk leads from all lifecycle filters by default — they
      // have their own dedicated filter chips.
      result = result.filter(g => g.status === filter && !g.isDnc && !g.isJunk)
    }
    if (sourceFilter !== "all") result = result.filter(g => g.sourceType === sourceFilter)
    if (expandedPhone && !result.some(g => g.phone === expandedPhone)) {
      const pinned = groups.find(g => g.phone === expandedPhone)
      if (pinned) result = [pinned, ...result]
    }
    return result
  }, [groups, filter, sourceFilter, expandedPhone])

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

  // Build a synthetic Lead-shaped row for a chat.db iMessage so it slots
  // into the existing TimelineEvent renderer without changing its contract.
  // Status is a placeholder ("new") and is never read for synthetic rows.
  function syntheticFromIMessage(group: LeadGroup, m: SyntheticIMessage, idx: number): Lead {
    return {
      id: `imsg-${m.timestamp}-${idx}`,
      created_at: new Date(m.timestamp + APPLE_EPOCH_OFFSET_MS).toISOString(),
      source: group.source,
      source_type: group.sourceType,
      twilio_number: m.is_from_me ? null : "imessage",
      caller_phone: group.contactPhone,
      lead_type: "sms",
      message: m.text || null,
      recording_url: null,
      status: "new",
      notes: null,
      ai_notes: null,
      name: group.name,
      email: group.email,
      property_address: group.propertyAddress,
      suggested_reply: null,
    }
  }

  function syntheticFromGmail(group: LeadGroup, m: SyntheticGmail, idx: number): Lead {
    const subjectAndBody = `${m.subject || "(no subject)"}\n\n${m.body || ""}`.trim()
    return {
      id: `gmsg-${m.messageId || `${m.timestamp}-${idx}`}`,
      created_at: new Date(m.timestamp).toISOString(),
      source: group.source,
      source_type: group.sourceType,
      twilio_number: m.is_from_ryan ? null : "gmail",
      caller_phone: null,
      lead_type: "email",
      message: subjectAndBody,
      recording_url: null,
      status: "new",
      notes: null,
      ai_notes: null,
      name: m.is_from_ryan ? null : group.name,
      email: group.email,
      property_address: null,
      suggested_reply: null,
    }
  }

  // Merge synthetic events into extraEvents[groupKey], deduping against
  // both real lead rows and previously-synced synthetic rows by exact
  // message-text match (within direction). Fires opportunistically on
  // card expand; failures are silent so a sidecar hiccup doesn't hide the
  // card.
  const syncOnExpand = useCallback(async (group: LeadGroup) => {
    if (syncedGroups.has(group.phone)) return
    setSyncedGroups(prev => {
      const next = new Set(prev); next.add(group.phone); return next
    })

    const knownTexts = new Set(
      group.events.map(e => `${isOutbound(e) ? "out" : "in"}|${(e.message || "").trim()}`)
    )

    const tasks: Promise<Lead[]>[] = []

    // iMessage sync — only meaningful when we have a phone for the group.
    if (group.contactPhone) {
      tasks.push(
        fetch("/api/leads/sync-imessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: group.contactPhone }),
        })
          .then(r => r.ok ? r.json() : { messages: [] })
          .then((data) => {
            const msgs: SyntheticIMessage[] = data.messages || []
            return msgs
              .filter(m => {
                const k = `${m.is_from_me ? "out" : "in"}|${(m.text || "").trim()}`
                if (knownTexts.has(k)) return false
                knownTexts.add(k)
                return true
              })
              .map((m, i) => syntheticFromIMessage(group, m, i))
          })
          .catch(() => [])
      )
    }

    // Gmail sync — only when one of the group's existing rows carries a
    // gmail_thread_id (always set on email leads inserted post-Phase-7.4-pt2).
    const emailLead = group.events.find(e => e.lead_type === "email" && e.gmail_thread_id)
    if (emailLead) {
      tasks.push(
        fetch("/api/leads/sync-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId: emailLead.id }),
        })
          .then(r => r.ok ? r.json() : { messages: [] })
          .then((data) => {
            const msgs: SyntheticGmail[] = data.messages || []
            // Dedupe email synthetics against the original row by first 200 chars
            // (route.ts already wrote `subject\n\nbody` truncated). Comparing the
            // exact same prefix avoids surfacing the original lead twice.
            return msgs
              .filter(m => {
                const subjectAndBody = `${m.subject || "(no subject)"}\n\n${m.body || ""}`.trim()
                const k = `${m.is_from_ryan ? "out" : "in"}|${subjectAndBody.slice(0, 200)}`
                const collide = group.events.some(
                  e => `${isOutbound(e) ? "out" : "in"}|${(e.message || "").slice(0, 200)}` === k
                )
                return !collide
              })
              .map((m, i) => syntheticFromGmail(group, m, i))
          })
          .catch(() => [])
      )
    }

    if (tasks.length === 0) return
    const results = await Promise.all(tasks)
    const merged = results.flat()
    if (merged.length === 0) return
    setExtraEvents(prev => ({ ...prev, [group.phone]: [...(prev[group.phone] || []), ...merged] }))
  }, [syncedGroups])

  // Phase 7C — Part 3: fetch (or refresh) the cached AI summary for a
  // group. If the group already carries a summary in its derived state
  // (loaded from the leads table) we still call the endpoint — the
  // endpoint short-circuits to the cached row when nothing's changed,
  // and ensures the user sees a freshly-regenerated summary if a new
  // event landed since the last fetch.
  // Phase 7C — Part 7: on-demand draft generation. Fills the existing
  // composer textarea so Ryan can edit before sending.
  const generateDraft = useCallback(async (group: LeadGroup, channel: "imessage" | "email") => {
    const key = `${group.phone}:${channel}`
    setDraftingFor(key)
    setDraftError(null)
    try {
      const res = await fetch(`/api/leads/${group.mostRecentId}/draft-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      if (channel === "imessage") {
        setDraftMessage(prev => ({ ...prev, [group.phone]: data.message || "" }))
      } else {
        setEmailDraft(prev => ({ ...prev, [group.phone]: data.message || "" }))
      }
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e))
    } finally {
      setDraftingFor(null)
    }
  }, [])

  const fetchSummary = useCallback(async (group: LeadGroup) => {
    const key = group.phone
    setSummaries(prev => ({ ...prev, [key]: { text: prev[key]?.text || group.aiSummary || "", loading: true, error: null } }))
    try {
      const res = await fetch(`/api/leads/${group.mostRecentId}/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setSummaries(prev => ({ ...prev, [key]: { text: data.summary || "", loading: false, error: null } }))
      // Stamp onto the underlying lead so groupLeads picks it up after refetch.
      setLeads(prev => prev.map(l =>
        l.id === group.mostRecentId
          ? { ...l, ai_summary: data.summary, ai_summary_generated_at: data.generated_at }
          : l
      ))
    } catch (e) {
      setSummaries(prev => ({ ...prev, [key]: { text: prev[key]?.text || "", loading: false, error: e instanceof Error ? e.message : String(e) } }))
    }
  }, [])

  async function addPhone(group: LeadGroup, raw: string) {
    const trimmed = raw.trim()
    if (!trimmed) return
    setPhoneError(null)
    setSavingPhoneFor(group.phone)
    try {
      const res = await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: group.mostRecentId, caller_phone: trimmed }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const updated: Lead | undefined = body.lead
      const normalized = updated?.caller_phone ?? trimmed
      // Optimistic: stamp the normalized phone onto the lead row so the
      // group re-derives with contactPhone set and the Call button activates.
      setLeads(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, caller_phone: normalized } : l))
      setPhoneDraft(prev => ({ ...prev, [group.phone]: "" }))
      // Silent refresh — the group key was `email:<addr>` (since it had no
      // phone before) and groupLeads will now key it by the phone number.
      // Without a fresh fetch the syncedGroups Set still holds the old
      // email-key, so the synthetic timeline events render under a
      // dead key and disappear until the next 30s tick. The fetch
      // re-keys cleanly.
      void fetchLeads(true)
    } catch (e) {
      setPhoneError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingPhoneFor(null)
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
    if (!group.contactPhone) return
    setCallingFor(group.phone)
    setCallError(null)
    try {
      const res = await fetch("/api/leads/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: group.contactPhone,
          source: group.source,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setCallSuccess(group.phone)
      setTimeout(() => setCallSuccess(null), 4000)
      // Phase 7C — Part 5: clear any pending follow-up recommendation
      // since Ryan just acted on it. analyze-call will regenerate a new
      // recommendation from the recording's transcript when it lands.
      if (group.recommendedFollowupDate) {
        void fetch("/api/leads", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: group.mostRecentId,
            recommended_followup_date: null,
            followup_reason: null,
          }),
        }).catch(() => {})
      }
      // Refetch to surface the new outbound call row in the timeline.
      void fetchLeads(true)
    } catch (e) {
      setCallError(e instanceof Error ? e.message : String(e))
    } finally {
      setCallingFor(null)
    }
  }

  // Two-step confirm to avoid accidental hard-deletes. First click arms the
  // button (relabels to "Confirm delete"); second click within ~4s fires
  // the DELETE. Auto-disarms after the timeout if Ryan walks away.
  function armDelete(group: LeadGroup) {
    setDeleteArmedFor(group.phone)
    setDeleteError(null)
    setTimeout(() => {
      setDeleteArmedFor(prev => (prev === group.phone ? null : prev))
    }, 4000)
  }

  async function deleteLead(group: LeadGroup) {
    const ids = group.events.map(e => e.id)
    if (ids.length === 0) return
    setDeletingFor(group.phone)
    setDeleteError(null)
    try {
      const res = await fetch("/api/leads", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      // Optimistic: drop those rows from local state immediately so the
      // card disappears without waiting for the next fetch.
      const idSet = new Set(ids)
      setLeads(prev => prev.filter(l => !idSet.has(l.id)))
      setExpandedPhone(null)
      setDeleteArmedFor(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingFor(null)
    }
  }

  async function sendEmailReply(group: LeadGroup) {
    const text = (emailDraft[group.phone] ?? group.suggestedReply ?? "").trim()
    if (!text) return
    // The backend looks up the lead row by id and reads its twilio_number to
    // know which mailbox to send from, so we need an inbound email row from
    // this group (not an outbound reply we already sent).
    const emailLead = group.events.find(e => e.lead_type === "email" && !isOutbound(e))
    if (!emailLead) return
    setSendingEmailFor(group.phone)
    setEmailSendError(null)
    try {
      const res = await fetch("/api/leads/email-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: emailLead.id, message: text }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setEmailDraft(prev => ({ ...prev, [group.phone]: "" }))
      setEmailSendSuccess(group.phone)
      setTimeout(() => setEmailSendSuccess(null), 2500)
      // Refetch to pick up the outbound email row that the route just inserted.
      void fetchLeads(true)
    } catch (e) {
      setEmailSendError(e instanceof Error ? e.message : String(e))
    } finally {
      setSendingEmailFor(null)
    }
  }

  async function sendOutbound(group: LeadGroup) {
    const text = (draftMessage[group.phone] ?? group.suggestedReply ?? "").trim()
    if (!text) return
    if (!group.contactPhone) return
    setSendingFor(group.phone)
    setSendError(null)
    try {
      const res = await fetch("/api/leads/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: group.contactPhone,
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

  // Phase 7C — Part 6 actions. Each one optimistic-patches local state
  // (so the UI moves immediately) and refetches in the background to
  // catch any server-side derivations (DNC list write, drip auto-route).
  async function patchFlagOnGroup(group: LeadGroup, patch: Partial<Lead>) {
    setLeads(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, ...patch } : l))
    try {
      const res = await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: group.mostRecentId, ...patch }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
    } catch (e) {
      console.error("flag patch failed:", e)
      void fetchLeads(true)
    }
  }

  async function applyDripToGroup(group: LeadGroup) {
    try {
      const res = await fetch(`/api/leads/${group.mostRecentId}/apply-drip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      void fetchLeads(true)
    } catch (e) {
      console.error("apply-drip failed:", e)
      alert(`Apply Drip failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function flagDnc(group: LeadGroup) {
    if (!confirm(`Mark ${group.name || group.contactPhone || group.email || "this lead"} as DNC? This halts ALL outreach and adds them to the suppression list.`)) return
    setLeads(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, is_dnc: true, status: "dead" } : l))
    try {
      const res = await fetch(`/api/leads/${group.mostRecentId}/dnc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual" }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      void fetchLeads(true)
    } catch (e) {
      console.error("dnc failed:", e)
      void fetchLeads(true)
    }
  }

  async function clearDnc(group: LeadGroup) {
    setLeads(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, is_dnc: false } : l))
    try {
      await fetch(`/api/leads/${group.mostRecentId}/dnc`, { method: "DELETE" })
      void fetchLeads(true)
    } catch (e) {
      console.error("clear dnc failed:", e)
      void fetchLeads(true)
    }
  }

  async function acceptSuggestedStatus(group: LeadGroup) {
    if (!group.suggestedStatus) return
    const next = group.suggestedStatus
    setLeads(prev => prev.map(l =>
      l.id === group.mostRecentId
        ? { ...l, status: next, suggested_status: null, suggested_status_reason: null }
        : l
    ))
    await Promise.all([
      patchLead(group.mostRecentId, { status: next }),
      fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: group.mostRecentId,
          suggested_status: null,
          suggested_status_reason: null,
        }),
      }).catch(() => {}),
    ])
  }

  async function dismissSuggestedStatus(group: LeadGroup) {
    setLeads(prev => prev.map(l =>
      l.id === group.mostRecentId
        ? { ...l, suggested_status: null, suggested_status_reason: null }
        : l
    ))
    try {
      await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: group.mostRecentId,
          suggested_status: null,
          suggested_status_reason: null,
        }),
      })
    } catch (e) {
      console.error("dismiss suggestion failed:", e)
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function bulkApplyDrip() {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setBulkApplying(true)
    setBulkResult(null)
    try {
      const res = await fetch("/api/leads/bulk-apply-drip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: ids }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setBulkResult(`${data.succeeded}/${data.total} leads queued`)
      setSelectedIds(new Set())
      void fetchLeads(true)
      setTimeout(() => setBulkResult(null), 4000)
    } catch (e) {
      setBulkResult(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkApplying(false)
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
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <button
              onClick={bulkApplyDrip}
              disabled={bulkApplying}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 text-white text-xs font-medium transition-colors"
              title="Auto-route each selected lead to a drip campaign based on its contact info"
            >
              {bulkApplying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Apply Drip ({selectedIds.size})
            </button>
          )}
          {bulkResult && (
            <span className="text-xs text-zinc-400">{bulkResult}</span>
          )}
          <button
            onClick={() => fetchLeads()}
            disabled={refreshing}
            className="p-2 -mr-2 text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
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

      <CampaignMetricsStrip />

      <DripQueueSection leads={leads} onAfterAction={() => fetchLeads(true)} />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading leads…
        </div>
      ) : filteredGroups.length === 0 ? (
        <div className="text-sm text-zinc-500 py-12 text-center">
          {groups.length === 0
            ? "No leads yet."
            : `No ${STATUS_FILTERS.find(f => f.key === filter)?.label.toLowerCase() ?? filter} leads.`}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredGroups.map(group => (
            <LeadCard
              key={group.phone}
              group={group}
              extraEvents={extraEvents[group.phone] || []}
              expanded={expandedPhone === group.phone}
              onToggle={() => {
                const willExpand = expandedPhone !== group.phone
                setExpandedPhone(willExpand ? group.phone : null)
                if (willExpand) {
                  void syncOnExpand(group)
                  // Auto-fetch the AI summary on expand. The endpoint
                  // short-circuits when the cached value is still fresh,
                  // so this is cheap on a re-expand.
                  if (!summaries[group.phone]?.loading) void fetchSummary(group)
                }
              }}
              summary={summaries[group.phone]?.text || group.aiSummary || ""}
              summaryLoading={!!summaries[group.phone]?.loading}
              summaryError={summaries[group.phone]?.error || null}
              onRefreshSummary={() => fetchSummary(group)}
              onDraftText={() => generateDraft(group, "imessage")}
              onDraftEmail={() => generateDraft(group, "email")}
              draftingText={draftingFor === `${group.phone}:imessage`}
              draftingEmail={draftingFor === `${group.phone}:email`}
              draftError={expandedPhone === group.phone ? draftError : null}
              onPatchField={(field, value) => patchFlagOnGroup(group, { [field]: value || null } as Partial<Lead>)}
              onSetStatus={(s) => setGroupStatus(group, s)}
              pendingStatus={pendingStatus}
              draftNote={draftNotes[group.phone]}
              onEditNote={(v) => setDraftNotes(prev => ({ ...prev, [group.phone]: v }))}
              onFocusNote={() => startEditingNotes(group)}
              onCommitNote={() => commitNotes(group)}
              draftMessage={draftMessage[group.phone] ?? group.suggestedReply ?? ""}
              onEditMessage={(v) => setDraftMessage(prev => ({ ...prev, [group.phone]: v }))}
              onSend={() => sendOutbound(group)}
              sending={sendingFor === group.phone}
              sendError={sendingFor === null && sendError && expandedPhone === group.phone ? sendError : null}
              sendSuccess={sendSuccess === group.phone}
              onCall={() => callLead(group)}
              calling={callingFor === group.phone}
              callError={callingFor === null && callError && expandedPhone === group.phone ? callError : null}
              callSuccess={callSuccess === group.phone}
              phoneDraft={phoneDraft[group.phone] ?? ""}
              onEditPhoneDraft={(v) => setPhoneDraft(prev => ({ ...prev, [group.phone]: v }))}
              onSavePhone={() => addPhone(group, phoneDraft[group.phone] ?? "")}
              savingPhone={savingPhoneFor === group.phone}
              phoneError={savingPhoneFor === null && phoneError && expandedPhone === group.phone ? phoneError : null}
              emailDraft={emailDraft[group.phone] ?? group.suggestedReply ?? ""}
              onEditEmailDraft={(v) => setEmailDraft(prev => ({ ...prev, [group.phone]: v }))}
              onSendEmail={() => sendEmailReply(group)}
              sendingEmail={sendingEmailFor === group.phone}
              emailSendSuccess={emailSendSuccess === group.phone}
              emailSendError={sendingEmailFor === null && emailSendError && expandedPhone === group.phone ? emailSendError : null}
              onArmDelete={() => armDelete(group)}
              onConfirmDelete={() => deleteLead(group)}
              deleteArmed={deleteArmedFor === group.phone}
              deleting={deletingFor === group.phone}
              deleteError={deletingFor === null && deleteError && expandedPhone === group.phone ? deleteError : null}
              selected={selectedIds.has(group.mostRecentId)}
              onToggleSelect={() => toggleSelect(group.mostRecentId)}
              onApplyDrip={() => applyDripToGroup(group)}
              onMarkBadNumber={() => patchFlagOnGroup(group, { is_bad_number: !group.isBadNumber })}
              onMarkJunk={() => patchFlagOnGroup(group, { is_junk: !group.isJunk })}
              onFlagDnc={() => flagDnc(group)}
              onClearDnc={() => clearDnc(group)}
              onAcceptSuggestion={() => acceptSuggestedStatus(group)}
              onDismissSuggestion={() => dismissSuggestedStatus(group)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface LeadCardProps {
  group: LeadGroup
  extraEvents: Lead[]
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
  phoneDraft: string
  onEditPhoneDraft: (v: string) => void
  onSavePhone: () => void
  savingPhone: boolean
  phoneError: string | null
  emailDraft: string
  onEditEmailDraft: (v: string) => void
  onSendEmail: () => void
  sendingEmail: boolean
  emailSendSuccess: boolean
  emailSendError: string | null
  onArmDelete: () => void
  onConfirmDelete: () => void
  deleteArmed: boolean
  deleting: boolean
  deleteError: string | null
  // Phase 7C
  selected: boolean
  onToggleSelect: () => void
  onApplyDrip: () => void
  onMarkBadNumber: () => void
  onMarkJunk: () => void
  onFlagDnc: () => void
  onClearDnc: () => void
  onAcceptSuggestion: () => void
  onDismissSuggestion: () => void
  summary: string
  summaryLoading: boolean
  summaryError: string | null
  onRefreshSummary: () => void
  onDraftText: () => void
  onDraftEmail: () => void
  draftingText: boolean
  draftingEmail: boolean
  draftError: string | null
  onPatchField: (field: "name" | "property_address" | "email", value: string) => void
}

function LeadCard(p: LeadCardProps) {
  const { group, expanded } = p
  const Icon = TYPE_ICON[group.mostRecentEvent.lead_type ?? "call"] || Phone
  // Display the campaign_label (Phase 7C overlay) when set, falling back to
  // the historical source. Untouched legacy rows that aren't relabeled fall
  // through to "Unknown".
  const displayCampaign = group.campaignLabel || group.source || "Unknown"
  const sourceClass = SOURCE_BADGE[displayCampaign] || SOURCE_BADGE.Unknown
  const sourceTypeClass = group.sourceType ? SOURCE_TYPE_BADGE[group.sourceType] : null
  const phoneDisplay = group.contactPhone ? formatPhone(group.contactPhone) : null
  const onDrip = !!group.events.find(e => e.drip_campaign_type)?.drip_campaign_type
  const canApplyDrip = !onDrip && !group.isDnc && !group.isJunk && (group.contactPhone || group.email)
  // The reply composer should reflect the lead's primary inbound channel —
  // the original email — not whatever the latest event happens to be (which
  // may be a drip-sent row). Email leads have at least one inbound email
  // event in the group; that's the only condition we need.
  const isEmailLead = group.events.some(e => e.lead_type === "email" && !isOutbound(e))
  const nextDripLabel = nextDripETA(group)

  return (
    <div className={`rounded-md border bg-zinc-950 overflow-hidden ${
      group.isDnc
        ? "border-red-900"
        : group.isJunk
        ? "border-zinc-800 opacity-70"
        : "border-zinc-800"
    }`}>
      <div className="flex items-center">
        {/* Bulk-select checkbox — clicking does NOT expand the card. */}
        <label
          className="pl-3 py-3 flex items-center cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={p.selected}
            onChange={p.onToggleSelect}
            className="w-4 h-4 accent-emerald-600"
            aria-label="Select for bulk action"
          />
        </label>
        <button
          onClick={p.onToggle}
          className="flex-1 px-3 py-3 flex items-center gap-3 text-left hover:bg-zinc-900/50 transition-colors"
        >
          <div className="flex flex-col gap-0.5 shrink-0">
            <span className={`px-2 py-0.5 text-[10px] font-semibold rounded uppercase tracking-wider ${sourceClass}`}>
              {displayCampaign}
            </span>
            {sourceTypeClass && (
              <span className={`px-2 py-0.5 text-[9px] font-semibold rounded uppercase tracking-wider ${sourceTypeClass}`}>
                {SOURCE_TYPE_LABEL[group.sourceType!] || group.sourceType}
              </span>
            )}
          </div>
          <Icon className="w-4 h-4 text-zinc-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-zinc-100 font-medium truncate flex items-center gap-2">
              <span className="truncate">{group.name || phoneDisplay || group.email || "(unknown)"}</span>
              {group.isDnc && (
                <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded uppercase tracking-wider bg-red-950 text-red-300 border border-red-900 shrink-0">
                  DNC
                </span>
              )}
              {group.isJunk && (
                <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded uppercase tracking-wider bg-zinc-800 text-zinc-400 shrink-0">
                  Junk
                </span>
              )}
              {group.isBadNumber && (
                <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded uppercase tracking-wider bg-amber-950 text-amber-300 border border-amber-900 shrink-0">
                  Bad #
                </span>
              )}
            </div>
            {group.name && (
              <div className={`text-xs text-zinc-500 truncate ${group.isBadNumber ? "line-through" : ""}`}>
                {phoneDisplay || group.email || ""}
              </div>
            )}
            <div className="text-xs text-zinc-500 truncate">
              {relativeTime(group.mostRecentEvent.created_at)}
              {group.events.length > 1 && ` · ${group.events.length} events`}
              {onDrip && " · 🤖 drip"}
            </div>
          </div>
          <span className={`px-2 py-0.5 text-[10px] font-semibold rounded uppercase tracking-wider ${STATUS_BADGE[group.status]}`}>
            {group.status}
          </span>
          {expanded
            ? <ChevronDown className="w-4 h-4 text-zinc-600 shrink-0" />
            : <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 px-3 py-3 space-y-3">
          {/* Phase 7C — Part 4 banner: AI suggested status + reason. Both
              actions clear the suggestion fields; Accept also patches
              status, Dismiss leaves the lifecycle stage alone. */}
          {group.suggestedStatus && (
            <div className="rounded-md border border-purple-900/60 bg-purple-950/20 px-3 py-2 flex items-start gap-2">
              <Sparkles className="w-4 h-4 text-purple-300 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-purple-300/80 mb-0.5">
                  AI suggests:{" "}
                  <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded uppercase tracking-wider ${STATUS_BADGE[group.suggestedStatus]}`}>
                    {STATUS_LABEL[group.suggestedStatus]}
                  </span>
                </div>
                {group.suggestedStatusReason && (
                  <div className="text-xs text-zinc-300">{group.suggestedStatusReason}</div>
                )}
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={p.onAcceptSuggestion}
                  className="px-2.5 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white text-xs font-medium"
                >
                  Accept
                </button>
                <button
                  onClick={p.onDismissSuggestion}
                  className="px-2.5 py-1 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 text-xs"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Phase 7C — Part 3: AI summary (cached, regenerated only on
              new activity). Shows a spinner on first fetch, instant on
              re-expand thanks to the cache + local state. */}
          <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-zinc-400" /> AI summary
              </div>
              <button
                onClick={p.onRefreshSummary}
                disabled={p.summaryLoading}
                className="text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-50 inline-flex items-center gap-1"
                title="Regenerate"
              >
                <RefreshCw className={`w-3 h-3 ${p.summaryLoading ? "animate-spin" : ""}`} />
                {p.summaryLoading ? "Generating…" : "Refresh"}
              </button>
            </div>
            {p.summary ? (
              <div className="text-sm text-zinc-200 whitespace-pre-wrap">{p.summary}</div>
            ) : p.summaryLoading ? (
              <div className="text-sm text-zinc-500 italic">Generating summary…</div>
            ) : p.summaryError ? (
              <div className="text-sm text-red-300">{p.summaryError}</div>
            ) : (
              <div className="text-sm text-zinc-500 italic">No summary yet.</div>
            )}
          </div>

          <div className="text-sm flex items-center gap-3 flex-wrap">
            {group.contactPhone ? (
              <>
                <a
                  href={`tel:${group.contactPhone}`}
                  className="inline-flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 underline-offset-2 hover:underline"
                >
                  <Phone className="w-3.5 h-3.5" />
                  {phoneDisplay}
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
              </>
            ) : (
              <div className="flex items-center gap-2 flex-wrap w-full">
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  value={p.phoneDraft}
                  onChange={e => p.onEditPhoneDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && p.phoneDraft.trim() && !p.savingPhone) {
                      p.onSavePhone()
                    }
                  }}
                  placeholder="Add phone number"
                  disabled={p.savingPhone}
                  className="flex-1 min-w-[160px] bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 disabled:opacity-50"
                  style={{ fontSize: 16 }}
                />
                <button
                  onClick={p.onSavePhone}
                  disabled={p.savingPhone || !p.phoneDraft.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
                  title="Attach this phone number to the lead — activates the Call button"
                >
                  {p.savingPhone ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  {p.savingPhone ? "Saving…" : "Save"}
                </button>
                {p.phoneError && (
                  <span className="text-red-300 text-xs basis-full">{p.phoneError}</span>
                )}
              </div>
            )}
            {group.email && (
              <span className="ml-auto text-zinc-400 text-xs">📧 {group.email}</span>
            )}
          </div>

          {/* Phase 7C+ — editable name + property. Self-identification in
              voicemail bodies is the most authoritative source, but parsers
              still miss occasionally (e.g. Google Voice forwards arrive
              with name="Google Voice" until the body regex catches up).
              These inline-editable fields let Ryan correct in one tap. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
            <EditableInlineField
              value={group.name}
              placeholder="Add name"
              icon="👤"
              onSave={(v) => p.onPatchField("name", v)}
            />
            <EditableInlineField
              value={group.propertyAddress}
              placeholder="Add property address"
              icon="🏠"
              onSave={(v) => p.onPatchField("property_address", v)}
            />
          </div>

          {nextDripLabel && (
            <div className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              <span>Next drip {nextDripLabel}</span>
            </div>
          )}

          {group.recommendedFollowupDate && (
            <div className="rounded border border-emerald-900/40 bg-emerald-950/20 px-3 py-1.5 text-xs text-emerald-200 inline-flex items-center gap-2 max-w-full">
              <Calendar className="w-3 h-3 shrink-0" />
              <span className="font-medium">Follow up {new Date(group.recommendedFollowupDate + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric" })}</span>
              {group.followupReason && <span className="text-zinc-300 truncate">— {group.followupReason}</span>}
            </div>
          )}

          <Timeline events={mergeForTimeline(group.events, p.extraEvents)} />

          {group.aiNotes && (
            <div className="bg-zinc-900/50 border border-zinc-800 rounded px-3 py-2">
              <div className="text-xs text-zinc-500 mb-1">🤖 AI Notes</div>
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

          {isEmailLead ? (
            // Email-lead composer: reply via Gmail API (blue Send Email).
            // If the lead also has a phone, an iMessage sub-composer renders
            // below — Ryan can pick the channel that fits the lead's reply.
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-xs text-zinc-500">
                  {group.suggestedReply ? "💡 Suggested Reply" : "Email Reply"}
                </div>
                <button
                  onClick={p.onDraftEmail}
                  disabled={p.draftingEmail}
                  className="text-[11px] text-purple-300 hover:text-purple-200 inline-flex items-center gap-1 disabled:opacity-50"
                  title="Have AI draft an email based on the conversation"
                >
                  {p.draftingEmail ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                  {p.draftingEmail ? "Drafting…" : "AI draft"}
                </button>
              </div>
              <textarea
                value={p.emailDraft}
                onChange={e => p.onEditEmailDraft(e.target.value)}
                placeholder="Write an email reply…"
                rows={3}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 resize-none"
                style={{ fontSize: 16 }}
                disabled={p.sendingEmail}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <div className="text-xs text-zinc-500 flex-1 min-w-0 truncate">
                  {p.emailSendError && <span className="text-red-300">{p.emailSendError}</span>}
                  {p.draftError && !p.emailSendError && <span className="text-red-300">{p.draftError}</span>}
                  {p.emailSendSuccess && (
                    <span className="text-emerald-400 inline-flex items-center gap-1">
                      <Check className="w-3 h-3" /> Email sent
                    </span>
                  )}
                </div>
                <button
                  onClick={p.onSendEmail}
                  disabled={p.sendingEmail || !p.emailDraft.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium transition-colors"
                >
                  {p.sendingEmail ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  Send Email
                </button>
              </div>
              {group.contactPhone && (
                <div className="mt-3 pt-3 border-t border-zinc-800">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="text-xs text-zinc-500">Or send iMessage</div>
                    <button
                      onClick={p.onDraftText}
                      disabled={p.draftingText}
                      className="text-[11px] text-purple-300 hover:text-purple-200 inline-flex items-center gap-1 disabled:opacity-50"
                      title="Have AI draft a text based on the conversation"
                    >
                      {p.draftingText ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                      {p.draftingText ? "Drafting…" : "AI draft"}
                    </button>
                  </div>
                  <textarea
                    value={p.draftMessage}
                    onChange={e => p.onEditMessage(e.target.value)}
                    placeholder="Send a message…"
                    rows={2}
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
                      iMessage
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            // Phone-only lead: existing iMessage composer, unchanged.
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-xs text-zinc-500">Send a message</div>
                {group.contactPhone && (
                  <button
                    onClick={p.onDraftText}
                    disabled={p.draftingText}
                    className="text-[11px] text-purple-300 hover:text-purple-200 inline-flex items-center gap-1 disabled:opacity-50"
                    title="Have AI draft a text based on the conversation"
                  >
                    {p.draftingText ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                    {p.draftingText ? "Drafting…" : "AI draft"}
                  </button>
                )}
              </div>
              <textarea
                value={p.draftMessage}
                onChange={e => p.onEditMessage(e.target.value)}
                placeholder={
                  group.contactPhone
                    ? "Send a message…"
                    : "Add a phone number above to send an iMessage reply."
                }
                rows={3}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 resize-none"
                style={{ fontSize: 16 }}
                disabled={p.sending || !group.contactPhone}
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
                  disabled={p.sending || !p.draftMessage.trim() || !group.contactPhone}
                  className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium transition-colors"
                >
                  {p.sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Send
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            {(["new", "contacted", "active", "hot", "warm", "nurture", "dead"] as LeadStatus[]).map(s => {
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
                  {isPending ? <Loader2 className="w-3 h-3 animate-spin inline" /> : STATUS_LABEL[s]}
                </button>
              )
            })}
          </div>

          {/* Phase 7C — Part 6 action row. Apply Drip / Bad # / Mark Junk /
              DNC. Hidden once a lead is DNC except the "Remove DNC" reset. */}
          <div className="flex flex-wrap gap-1.5">
            {group.isDnc ? (
              <button
                onClick={p.onClearDnc}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-zinc-900 border border-red-900 text-red-300 hover:bg-red-950/40 text-xs font-medium transition-colors"
                title="Clear the DNC flag (also removes the dnc_list row)"
              >
                <ShieldOff className="w-3.5 h-3.5" />
                Remove DNC
              </button>
            ) : (
              <>
                {canApplyDrip && (
                  <button
                    onClick={p.onApplyDrip}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-emerald-900/40 border border-emerald-900 text-emerald-200 hover:bg-emerald-900/60 text-xs font-medium transition-colors"
                    title="Auto-route to drip campaign based on contact info"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    Apply Drip
                  </button>
                )}
                {group.contactPhone && (
                  <button
                    onClick={p.onMarkBadNumber}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded text-xs font-medium transition-colors ${
                      group.isBadNumber
                        ? "bg-amber-900/40 border border-amber-900 text-amber-200"
                        : "bg-zinc-900 border border-zinc-800 hover:border-amber-900/60 text-zinc-300 hover:text-amber-200"
                    }`}
                    title={group.isBadNumber ? "Clear bad-number flag" : "Mark phone bad — drip skips iMessage, sticks to email"}
                  >
                    <PhoneOff className="w-3.5 h-3.5" />
                    {group.isBadNumber ? "Bad # ✓" : "Bad Number"}
                  </button>
                )}
                <button
                  onClick={p.onMarkJunk}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded text-xs font-medium transition-colors ${
                    group.isJunk
                      ? "bg-zinc-800 border border-zinc-700 text-zinc-300"
                      : "bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400"
                  }`}
                  title={group.isJunk ? "Unmark junk" : "Mark junk — drip stops, lead stays for analytics"}
                >
                  {group.isJunk ? "Junk ✓" : "Mark Junk"}
                </button>
                <button
                  onClick={p.onFlagDnc}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-zinc-900 border border-zinc-800 hover:border-red-900 hover:text-red-300 text-zinc-400 text-xs font-medium transition-colors"
                  title="DNC — halts all outreach, adds to suppression list"
                >
                  <Ban className="w-3.5 h-3.5" />
                  DNC
                </button>
              </>
            )}
          </div>

          {/* Delete lead — destructive, two-step confirm. First click arms;
              second click within ~4s commits. Drops every event row in the
              group (deletes the whole conversation, not just one message). */}
          <div className="pt-2 border-t border-zinc-800/60 flex items-center justify-between gap-2">
            <div className="text-xs text-zinc-500 flex-1 min-w-0 truncate">
              {p.deleteError && <span className="text-red-300">{p.deleteError}</span>}
              {p.deleteArmed && !p.deleteError && (
                <span className="text-red-300">Click Confirm to delete {group.events.length} event{group.events.length === 1 ? "" : "s"}.</span>
              )}
            </div>
            {!p.deleteArmed ? (
              <button
                onClick={p.onArmDelete}
                disabled={p.deleting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-zinc-900 border border-zinc-800 hover:border-red-900 hover:text-red-300 text-zinc-500 text-xs transition-colors"
                title="Delete this lead and all its events"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete lead
              </button>
            ) : (
              <button
                onClick={p.onConfirmDelete}
                disabled={p.deleting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-red-700 hover:bg-red-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
              >
                {p.deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                {p.deleting ? "Deleting…" : "Confirm delete"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Strip a leading "<subject>\n\n" prefix off an event's message. Inbound
// email rows store "<subject>\n\n<body>" but outbound replies (from
// /api/leads/email-reply) store just the body. Synthetic events from
// /sync-email always wrap subject + body. Comparing body-only across the
// two sources keeps dedupe consistent regardless of who stored what.
function eventBodyOnly(m: string | null | undefined): string {
  const s = (m || "").trim()
  const sep = s.indexOf("\n\n")
  return sep > 0 ? s.slice(sep + 2) : s
}

function eventSig(l: Lead): string {
  return `${isOutbound(l) ? "out" : "in"}|${eventBodyOnly(l.message).slice(0, 200)}`
}

// Combine the group's authoritative events (from Supabase) with synthetic
// events merged in from chat.db / Gmail thread sync. Sorted oldest → newest
// so the existing Timeline renderer's chronological assumption holds.
//
// Render-time dedupe is critical here: the syncOnExpand path also dedupes
// synthetic events against the events it sees AT EXPAND TIME, but if Ryan
// replies via /api/leads/email-reply AFTER expanding, the new authoritative
// outbound row arrives in the next 30s `fetchLeads(true)` tick — the
// pre-existing synthetic version stays in `extraEvents` and renders
// alongside it as a duplicate bubble. Comparing body-only signatures here
// catches that case, plus the auth-vs-synthetic prefix-format mismatch
// (auth outbound is just-body; synthetic always wraps subject+body).
function mergeForTimeline(authoritative: Lead[], synthetic: Lead[]): Lead[] {
  if (synthetic.length === 0) return authoritative
  const authSigs = new Set(authoritative.map(eventSig))
  const filtered = synthetic.filter(s => !authSigs.has(eventSig(s)))
  return [...authoritative, ...filtered].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )
}

// Inline editable text field with a small pencil affordance. Used for
// name + property_address on the expanded LeadCard so Ryan can correct
// parser misses (e.g. "Google Voice" → "Chris Bola") in one tap. Saves
// on Enter or blur; Esc cancels.
function EditableInlineField(props: {
  value: string | null
  placeholder: string
  icon: string
  onSave: (value: string) => void | Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(props.value || "")
  // External value can change (e.g. silent refetch overwrites a stale row);
  // sync the draft so we don't render stale text after a successful save.
  useEffect(() => { setDraft(props.value || "") }, [props.value])

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1 group hover:text-zinc-200 transition-colors"
      >
        <span className="text-zinc-500">{props.icon}</span>
        <span className={props.value ? "text-zinc-300" : "text-zinc-600 italic"}>
          {props.value || props.placeholder}
        </span>
        <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity" />
      </button>
    )
  }

  const commit = () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed !== (props.value || "").trim()) {
      void props.onSave(trimmed)
    }
  }

  return (
    <div className="inline-flex items-center gap-1">
      <span className="text-zinc-500">{props.icon}</span>
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit() }
          else if (e.key === "Escape") { setDraft(props.value || ""); setEditing(false) }
        }}
        className="bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-500 min-w-[160px]"
        style={{ fontSize: 16 }}
        placeholder={props.placeholder}
      />
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

  // Skip rendering for content-less events that aren't a call (which has its
  // own "Inbound/Outbound call · awaiting recording" placeholder) and aren't
  // a form (which renders a static "Website form submission" line). This
  // catches stale outbound rows whose message column never got populated and
  // would otherwise render as a useless "(empty)" bubble.
  const hasContent = !!(ev.message || ev.recording_url)
  if (!hasContent && ev.lead_type !== "call" && ev.lead_type !== "form") {
    return null
  }

  if (outbound) {
    // Right-aligned bubble, emerald accent — Ryan's outbound message or call.
    // For outbound calls: show recording + transcription if attached, else
    // a placeholder so a fresh "ringing" call isn't rendered as missing.
    // Drip-engine-sent rows (lead_type prefixed `drip_`) get a 🤖 Auto label
    // so Ryan can tell at a glance whether he or the engine sent it.
    const isOutboundCall = ev.lead_type === "call"
    const isDrip = ev.lead_type === "drip_imessage" || ev.lead_type === "drip_email"
    const senderLabel = isDrip ? "🤖 Auto" : "You"
    const channelSuffix = isOutboundCall
      ? " · outbound call"
      : isDrip
        ? ev.lead_type === "drip_email" ? " · drip email" : " · drip iMessage"
        : ""
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-emerald-900/30 border border-emerald-900/50 rounded px-3 py-2 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-emerald-400/70 flex items-center gap-1.5">
            <span>{senderLabel}{channelSuffix} · {fullTime}</span>
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
            // Guarded above — message is non-null here.
            <div className="text-sm text-zinc-100 whitespace-pre-wrap break-words">
              {ev.message}
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
        {ev.lead_type === "email" && ev.message && (
          // `message` for email rows is "<subject>\n\n<body>" — we show
          // the whole block as plain text. No audio player; the email body
          // replaces it. Empty-message email rows are filtered out by the
          // hasContent guard at the top of TimelineEvent.
          <div className="text-sm text-zinc-200 bg-zinc-900 rounded px-3 py-2 whitespace-pre-wrap break-words">
            {ev.message}
          </div>
        )}
      </div>
    </div>
  )
}

// Phase 7C — Part 10: per-campaign rollup strip. Pulls precomputed rows
// from /api/campaign-metrics. Recompute is on-demand for now via
//   node scripts/compute-campaign-metrics.mjs
interface CampaignMetricRow {
  campaign_source: string
  total_leads: number
  total_calls: number
  total_texts: number
  total_emails: number
  total_voicemails: number
  hot_count: number
  warm_count: number
  nurture_count: number
  dead_count: number
  dnc_count: number
  junk_count: number
  last_computed_at: string | null
}

function CampaignMetricsStrip() {
  const [rows, setRows] = useState<CampaignMetricRow[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let mounted = true
    fetch("/api/campaign-metrics", { cache: "no-store" })
      .then(r => r.ok ? r.json() as Promise<{ rows: CampaignMetricRow[] }> : { rows: [] })
      .then(data => { if (mounted) setRows(data.rows || []) })
      .catch(() => {})
    return () => { mounted = false }
  }, [])
  if (rows.length === 0) return null
  return (
    <div className="mb-4 rounded-md border border-zinc-800 bg-zinc-950 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-3 py-2 flex items-center justify-between text-sm hover:bg-zinc-900/50 transition-colors"
      >
        <span className="text-zinc-300 font-medium">Campaign analytics</span>
        <span className="text-xs text-zinc-500">{rows.length} campaign{rows.length === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <div className="border-t border-zinc-800 px-3 py-2 space-y-1.5 text-xs">
          {rows.map(r => (
            <div key={r.campaign_source} className="flex items-center gap-2 text-zinc-300 flex-wrap">
              <span className="font-semibold text-zinc-100 min-w-[80px]">{r.campaign_source}</span>
              <span>{r.total_leads} leads</span>
              <span className="text-zinc-500">·</span>
              <span>{r.total_calls} calls</span>
              <span>{r.total_texts} texts</span>
              <span>{r.total_emails} emails</span>
              <span className="text-zinc-500">·</span>
              <span className="text-red-300">{r.hot_count} hot</span>
              <span className="text-amber-300">{r.warm_count} warm</span>
              <span className="text-emerald-300">{r.nurture_count} nurture</span>
              <span className="text-zinc-500">{r.dead_count} dead</span>
              {r.dnc_count > 0 && <span className="text-red-400">{r.dnc_count} dnc</span>}
              {r.junk_count > 0 && <span className="text-zinc-500">{r.junk_count} junk</span>}
            </div>
          ))}
          <div className="pt-1 text-[10px] text-zinc-600">
            Recompute: <code className="text-zinc-500">node scripts/compute-campaign-metrics.mjs</code>
          </div>
        </div>
      )}
    </div>
  )
}

// Drip-queue approval section. Pending touches generated by the drip
// engine sit here until Ryan taps Approve or Skip. Approved items get
// drained on the engine's next hourly pass; skipped items just stay
// recorded for audit (the engine already advanced the lead's counters
// when it queued the touch).
function DripQueueSection({ leads, onAfterAction }: { leads: Lead[]; onAfterAction: () => void }) {
  const [items, setItems] = useState<DripQueueItem[]>([])
  const [loading, setLoading] = useState(false)
  const [actingOn, setActingOn] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const fetchQueue = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/leads/drip-queue?status=pending", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(data.items ?? [])
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchQueue()
    const id = setInterval(() => void fetchQueue(), 30000)
    return () => clearInterval(id)
  }, [fetchQueue])

  async function decide(id: string, action: "approve" | "skip") {
    setActingOn(id)
    setErr(null)
    try {
      const res = await fetch("/api/leads/drip-queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      setItems(prev => prev.filter(q => q.id !== id))
      onAfterAction()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  if (!loading && items.length === 0 && !err) return null

  // Map lead_id → lead so we can render a recipient label.
  const leadById = new Map(leads.map(l => [l.id, l]))

  return (
    <div className="mb-4 rounded-md border border-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2 text-sm">
        <Bot className="w-4 h-4 text-zinc-400" />
        <span className="text-zinc-200 font-medium">Drip queue</span>
        <span className="text-xs text-zinc-500">{items.length} pending</span>
      </div>
      {err && (
        <div className="px-3 py-2 text-xs text-red-300 bg-red-900/20">{err}</div>
      )}
      <div className="divide-y divide-zinc-900">
        {items.map(it => {
          const lead = leadById.get(it.lead_id)
          const recipient = lead?.name || (lead?.caller_phone ? formatPhone(lead.caller_phone) : null) || lead?.email || it.lead_id
          const channel = it.channel === "imessage" ? "iMessage" : "Email"
          const acting = actingOn === it.id
          return (
            <div key={it.id} className="px-3 py-3 space-y-2">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span className="text-zinc-300 font-medium">{recipient}</span>
                <span>·</span>
                <span>#{it.touch_number} {channel}</span>
                <span>·</span>
                <span>{relativeTime(it.created_at)}</span>
              </div>
              {it.subject && (
                <div className="text-xs text-zinc-400">Subject: {it.subject}</div>
              )}
              <div className="text-sm text-zinc-200 bg-zinc-900 rounded px-3 py-2 whitespace-pre-wrap break-words">
                {it.message}
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => decide(it.id, "skip")}
                  disabled={acting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 text-xs font-medium transition-colors disabled:opacity-60"
                >
                  {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                  Skip
                </button>
                <button
                  onClick={() => decide(it.id, "approve")}
                  disabled={acting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
                >
                  {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  Approve
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
