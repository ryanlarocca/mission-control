"use client"

import { useEffect, useMemo, useState, useCallback } from "react"
import {
  Phone, PhoneOutgoing, Voicemail, MessageSquare, ClipboardList, ChevronDown, ChevronRight,
  Loader2, RefreshCw, Send, Check, Mail, Trash2, Bot, Clock, X,
} from "lucide-react"
import { getCampaign, getNextTouch } from "@/lib/drip-campaigns"

type LeadType =
  | "call" | "voicemail" | "sms" | "form" | "email"
  | "drip_imessage" | "drip_email"
type LeadStatus =
  | "new" | "hot" | "qualified" | "warm" | "junk" | "contacted"
  | "active" | "unqualified" | "do_not_contact"
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
}

const STATUS_FILTERS: ({ key: "all" | LeadStatus; label: string })[] = [
  { key: "all",            label: "All" },
  { key: "new",            label: "New" },
  { key: "hot",            label: "Hot" },
  { key: "qualified",      label: "Qualified" },
  { key: "warm",           label: "Warm" },
  { key: "active",         label: "Active" },
  { key: "contacted",      label: "Contacted" },
  { key: "unqualified",    label: "Unqualified" },
  { key: "junk",           label: "Junk" },
  { key: "do_not_contact", label: "DNC" },
]

const SOURCE_TYPE_FILTERS: ({ key: "all" | SourceType; label: string })[] = [
  { key: "all",          label: "All Sources" },
  { key: "direct_mail",  label: "Direct Mail" },
  { key: "google_ads",   label: "Google Ads" },
]

const STATUS_BADGE: Record<LeadStatus, string> = {
  new:            "bg-zinc-700 text-zinc-200",
  hot:            "bg-red-900/60 text-red-200",
  qualified:      "bg-emerald-900/60 text-emerald-200",
  warm:           "bg-amber-900/60 text-amber-200",
  junk:           "bg-zinc-800 text-zinc-500",
  contacted:      "bg-blue-900/60 text-blue-200",
  active:         "bg-sky-900/60 text-sky-200",
  unqualified:    "bg-zinc-700/80 text-zinc-300",
  do_not_contact: "bg-red-950 text-red-300 border border-red-900",
}

const SOURCE_BADGE: Record<string, string> = {
  "MFM-A":      "bg-sky-900/60 text-sky-200",
  "MFM-B":      "bg-purple-900/60 text-purple-200",
  // Email-campaign mailers share buckets with their phone-number siblings,
  // so SVG-A matches MFM-A's color and SVJ-B matches MFM-B's.
  "SVG-A":      "bg-sky-900/60 text-sky-200",
  "SVJ-B":      "bg-purple-900/60 text-purple-200",
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
  call:          Phone,
  voicemail:     Voicemail,
  sms:           MessageSquare,
  form:          ClipboardList,
  email:         Mail,
  drip_imessage: Bot,
  drip_email:    Bot,
}

const STATUS_LABEL: Record<LeadStatus, string> = {
  new:            "New",
  hot:            "Hot",
  qualified:      "Qualified",
  warm:           "Warm",
  junk:           "Junk",
  contacted:      "Contacted",
  active:         "Active",
  unqualified:    "Unqualified",
  do_not_contact: "DNC",
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
// touches, or sits in a stop-status (active/junk/do_not_contact). The
// engine itself enforces all the same rules; this is a UI-only hint.
function nextDripETA(group: LeadGroup): string | null {
  const stopStatuses: LeadStatus[] = ["active", "junk", "do_not_contact"]
  if (stopStatuses.includes(group.status)) return null
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
    // Email leads with a Gmail thread always group by thread — a Gmail
    // conversation is one card, regardless of how the caller_phone field
    // shifts across messages (e.g. customer initially writes one number,
    // then "sorry my real number is X" in a follow-up). Without thread
    // priority each correction would split into a new card.
    //
    // Twilio leads (call/sms/voicemail) and email leads without a thread
    // fall back to the original phone → email → id chain.
    let key: string
    if (l.lead_type === "email" && l.gmail_thread_id) {
      key = `thread:${l.gmail_thread_id}`
    } else if (l.caller_phone) {
      key = l.caller_phone
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

      <DripQueueSection leads={leads} onAfterAction={() => fetchLeads(true)} />

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
              extraEvents={extraEvents[group.phone] || []}
              expanded={expandedPhone === group.phone}
              onToggle={() => {
                const willExpand = expandedPhone !== group.phone
                setExpandedPhone(willExpand ? group.phone : null)
                if (willExpand) void syncOnExpand(group)
              }}
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
}

function LeadCard(p: LeadCardProps) {
  const { group, expanded } = p
  const Icon = TYPE_ICON[group.mostRecentEvent.lead_type ?? "call"] || Phone
  const sourceClass = SOURCE_BADGE[group.source || "Unknown"] || SOURCE_BADGE.Unknown
  const sourceTypeClass = group.sourceType ? SOURCE_TYPE_BADGE[group.sourceType] : null
  const phoneDisplay = group.contactPhone ? formatPhone(group.contactPhone) : null
  // The reply composer should reflect the lead's primary inbound channel —
  // the original email — not whatever the latest event happens to be (which
  // may be a drip-sent row). Email leads have at least one inbound email
  // event in the group; that's the only condition we need.
  const isEmailLead = group.events.some(e => e.lead_type === "email" && !isOutbound(e))
  const nextDripLabel = nextDripETA(group)

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
            {group.name || phoneDisplay || group.email || "(unknown)"}
          </div>
          {group.name && (
            <div className="text-xs text-zinc-500 truncate">
              {phoneDisplay || group.email || ""}
            </div>
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

          {group.propertyAddress && (
            <div className="text-xs text-zinc-400">
              <span className="text-zinc-500">🏠 </span>{group.propertyAddress}
            </div>
          )}

          {nextDripLabel && (
            <div className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              <span>Next drip {nextDripLabel}</span>
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
              <div className="text-xs text-zinc-500 mb-1.5">
                {group.suggestedReply ? "💡 Suggested Reply" : "Email Reply"}
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
                  <div className="text-xs text-zinc-500 mb-1.5">Or send iMessage</div>
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
              <div className="text-xs text-zinc-500 mb-1.5">Send a message</div>
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
            {(["hot", "qualified", "warm", "active", "contacted", "unqualified", "junk", "do_not_contact"] as LeadStatus[]).map(s => {
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
