"use client"

import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { useSearchParams } from "next/navigation"
import {
  Phone, PhoneOutgoing, Voicemail, MessageSquare, ClipboardList, ChevronDown, ChevronRight,
  Loader2, RefreshCw, Send, Check, Mail, Trash2, Bot, Clock, X,
  Sparkles, PhoneOff, Ban, ShieldOff, Zap, Wand2, Pencil, Search, SlidersHorizontal,
  Maximize2, Hourglass,
} from "lucide-react"
import {
  resolveNextTouch, describeTouchWhen, classifyUrgency,
  type NextTouch, type NextTouchSummary,
} from "@/lib/next-touch"
import { isAnonymousCaller } from "@/lib/anonymous"
import type { LeadStatus, PropertyDetail } from "@/lib/leads"
import { formatPhone } from "@/lib/utils"
import {
  type RelationshipCategory,
  RELATIONSHIP_CATEGORY_LABELS,
  RELATIONSHIP_CATEGORY_PICKER_ORDER,
} from "@/lib/crms"

type LeadType =
  | "call" | "voicemail" | "sms" | "form" | "email"
  | "drip_imessage" | "drip_email"
type Temperature = "hot" | "warm" | "cold"
type SourceType = "direct_mail" | "google_ads"

const TEMPERATURE_BADGE: Record<Temperature, { emoji: string; label: string; badgeClass: string; pillClass: string }> = {
  hot:  { emoji: "🔥", label: "Hot",  badgeClass: "bg-red-900/40 text-red-200 border-red-900/70",   pillClass: "bg-red-900/30 text-red-200" },
  warm: { emoji: "☀️", label: "Warm", badgeClass: "bg-amber-900/40 text-amber-200 border-amber-900/70", pillClass: "bg-amber-900/30 text-amber-200" },
  cold: { emoji: "❄️", label: "Cold", badgeClass: "bg-sky-900/40 text-sky-200 border-sky-900/70",  pillClass: "bg-sky-900/30 text-sky-200" },
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
  // Structured per-property specs (units, unit mix, rents, sqft, …). One entry
  // per property the seller owns. AI-populated + Ryan-editable on the card.
  property_details?: PropertyDetail[] | null
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
  // Phase 7D
  temperature?: Temperature | null
  // Campaign Performance — offer-detection columns added 2026-05-17.
  offer_amount?: number | null
  offer_verbalized_at?: string | null
  campaign_id?: string | null
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
  // Derived from whichever row in the group carries property_details (the
  // status-driving row is preferred — that's the PATCH target). Editable.
  propertyDetails: PropertyDetail[]
  mostRecentId: string             // id of the row whose status drives the group
  mostRecentEvent: Lead             // for header display
  mostRecentInbound: Lead | null   // most recent INBOUND event (for source/contact info)
  events: Lead[]                    // all events, oldest → newest
  inboundCount: number
  // Phase 7C derived/copied fields. Flags + intelligence fields live on the
  // status-driving row (the lead's "primary" row). Drip metadata lives on
  // the original intake row (read by the shared next-touch resolver).
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
  // Phase 7D — AI-driven temperature drives the badge in the lead card
  // header and the Temp filter in the chip row.
  temperature: Temperature | null
  // Campaign Performance tab: Ryan's stated offer to the seller and when it
  // was verbalized. Populated by analyzeCallTranscript / triageEmailLead
  // (hands-off — only writes when null). UI lets Ryan pencil-edit.
  offerAmount: number | null
  offerVerbalizedAt: string | null
}

// Phase 7D: top-row lifecycle chips only. Source / temperature / flag-hides
// live in the collapsible filter sheet so the chip row stays clean on mobile.
type LifecycleFilter = "all" | LeadStatus
const LIFECYCLE_FILTERS: { key: LifecycleFilter; label: string }[] = [
  { key: "all",       label: "All" },
  { key: "new",       label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "active",    label: "Active" },
  { key: "nurture",   label: "Nurture" },
  { key: "dead",      label: "Dead" },
]

const SOURCE_TYPE_FILTERS: ({ key: "all" | SourceType; label: string })[] = [
  { key: "all",          label: "All Sources" },
  { key: "direct_mail",  label: "Direct Mail" },
  { key: "google_ads",   label: "Google Ads" },
]

const TEMPERATURE_FILTERS: ({ key: "all" | Temperature; label: string })[] = [
  { key: "all",  label: "All" },
  { key: "hot",  label: "🔥 Hot" },
  { key: "warm", label: "☀️ Warm" },
  { key: "cold", label: "❄️ Cold" },
]

const STATUS_BADGE: Record<LeadStatus, string> = {
  new:        "bg-zinc-700 text-zinc-200",
  contacted:  "bg-blue-900/60 text-blue-200",
  active:     "bg-sky-900/60 text-sky-200",
  nurture:    "bg-amber-900/60 text-amber-200",
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
  nurture:    "Nurture",
  dead:       "Dead",
}

// formatPhone moved to lib/utils.ts (see import above).

// Cross-frame notification: the Drips tab renders LeadsTab inside a same-
// origin iframe overlay (embed=1). When a lead flag flips in a way that
// affects what the Drips tab should show (is_junk / is_dnc → halt-outreach
// sweep runs; ai temperature / followup → not relevant here), notify the
// parent so it can refetch immediately instead of waiting on its 30s poll.
// Outside an iframe the parent === self check is a no-op.
function notifyLeadChangedToParent(leadId: string, fields: string[]) {
  if (typeof window === "undefined") return
  if (window.parent === window) return
  try {
    window.parent.postMessage({ type: "lead-changed", leadId, fields }, window.location.origin)
  } catch {
    /* best-effort; cross-origin would throw but we restricted to same-origin embeds */
  }
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
    //
    // "Anonymous" (and other blocked-caller-ID placeholders) is NOT a real
    // contact key — every withheld caller shares the same value, so keying
    // on it would merge unrelated people into one card. Treat it as no
    // phone and fall through to the row-id key: one card per anonymous call.
    let key: string
    if (l.caller_phone && !isAnonymousCaller(l.caller_phone)) {
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
    // Take name/email/address from the status-driving row FIRST (this is the
    // row PATCH lands on — see mostRecentId below), so a manual correction
    // wins even when a NEWER outbound row baked the pre-correction value at
    // send time (e.g. [id]/send-email copies lead.name into its outbound
    // row; a later "newest-first" walk would otherwise surface that stale
    // copy and silently revert the edit on re-render). Falls back to newest
    // non-null across all events so older canonical values still surface
    // when the status row is blank.
    const pickIdentity = (key: "name" | "email" | "property_address"): string | null => {
      const fromStatus = statusSource[key]
      if (fromStatus && fromStatus.trim()) return fromStatus
      return newestFirst.map(e => e[key]).find(v => v && v.trim()) || null
    }
    const name = pickIdentity("name")
    const email = pickIdentity("email")
    const propertyAddress = pickIdentity("property_address")
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
    // Phase 7D — temperature can live on any row in the group; take the
    // newest. Falls back to the status-source row when no event has it set.
    const temperatureRow = newestFirst.find(e => e.temperature)
    const temperature: Temperature | null =
      (temperatureRow?.temperature as Temperature | null) ?? null
    // Property details — prefer the status-driving row (that's the PATCH
    // target for edits) so a hand-edit always wins; otherwise the newest row
    // that has any. The merge in the API keeps these consistent across rows.
    const propertyDetails: PropertyDetail[] =
      (Array.isArray(statusSource.property_details) && statusSource.property_details.length > 0
        ? statusSource.property_details
        : newestFirst.map(e => e.property_details).find(d => Array.isArray(d) && d.length > 0)) || []
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
      propertyDetails,
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
      temperature,
      // Offer — surface from whichever cluster row has it stamped. The
      // analyzer writes to the analyzed row; if there's a hand-edit on
      // any sibling, that wins via newest-first walk.
      offerAmount: newestFirst.find(r => typeof r.offer_amount === "number" && r.offer_amount > 0)?.offer_amount ?? null,
      offerVerbalizedAt: newestFirst.find(r => r.offer_verbalized_at)?.offer_verbalized_at ?? null,
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
  const [filter, setFilter]             = useState<LifecycleFilter>("all")
  const [search, setSearch]             = useState("")
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set())
  const [bulkApplying, setBulkApplying] = useState(false)
  const [bulkResult, setBulkResult]     = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<"all" | SourceType>("all")
  // Phase 7D — secondary filters live in a collapsible sheet so the chip row
  // stays clean on mobile. Defaults to all-pass; active values render as
  // removable pills next to the chip row.
  const [tempFilter, setTempFilter]     = useState<"all" | Temperature>("all")
  const [hideDnc, setHideDnc]           = useState(false)
  const [hideJunk, setHideJunk]         = useState(false)
  const [hideBadNumber, setHideBadNumber] = useState(false)
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
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
  // Subject line for a *fresh* email to a call-only lead (no Gmail thread to
  // inherit a subject from). Unused for thread replies. Keyed by group.phone.
  const [emailSubject, setEmailSubject] = useState<Record<string, string>>({})
  const [sendingEmailFor, setSendingEmailFor] = useState<string | null>(null)
  const [emailSendSuccess, setEmailSendSuccess] = useState<string | null>(null)
  const [emailSendError, setEmailSendError] = useState<string | null>(null)
  const [deleteArmedFor, setDeleteArmedFor] = useState<string | null>(null)
  const [deletingFor, setDeletingFor] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Promote → Relationships state. Per-card-open picker so two cards can't
  // both display the picker at once; in-flight + success/error per phone.
  const [promoteOpenFor, setPromoteOpenFor] = useState<string | null>(null)
  const [promotingFor, setPromotingFor] = useState<string | null>(null)
  const [promoteError, setPromoteError] = useState<string | null>(null)
  const [promoteSuccessFor, setPromoteSuccessFor] = useState<string | null>(null)
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

  // Bumped on every optimistic local edit (see applyLeadEdit). fetchLeads
  // discards any response whose request began before the latest edit, so a
  // slow in-flight refetch (or the 30s poll) can't silently revert it.
  const lastMutationAtRef = useRef(0)
  const fetchAbortRef = useRef<AbortController | null>(null)

  // Apply an optimistic edit to the leads list. Stamps the edit time so a
  // refetch already in flight won't clobber the user's just-applied change.
  const applyLeadEdit = useCallback((updater: (prev: Lead[]) => Lead[]) => {
    lastMutationAtRef.current = Date.now()
    setLeads(updater)
  }, [])

  const fetchLeads = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true)
    // Cancel any in-flight fetch so a slow earlier response can't land
    // after a newer one and overwrite it.
    fetchAbortRef.current?.abort()
    const ac = new AbortController()
    fetchAbortRef.current = ac
    const startedAt = Date.now()
    try {
      const res = await fetch("/api/leads?limit=500", { cache: "no-store", signal: ac.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      // Discard this snapshot if the user made an optimistic edit after the
      // request began — the server data predates the edit and would revert it.
      if (lastMutationAtRef.current > startedAt) return
      setLeads(data.leads ?? [])
      setError(null)
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      // Only the most-recent fetch owns the shared loading flags.
      if (fetchAbortRef.current === ac) {
        fetchAbortRef.current = null
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    fetchLeads()
    const id = setInterval(() => fetchLeads(true), 30000)
    return () => clearInterval(id)
  }, [fetchLeads])

  // Deep-link: /leads?phone=+15551234567 pre-expands the matching card and
  // scrolls it into view. Used by the Follow-Up tab so tapping a follow-up
  // row lands directly on the lead card.
  //
  // 2026-05-11 bugfix: previous version had `expandedPhone` in the deps
  // array of the expand effect, which meant any time the user clicked a
  // DIFFERENT card (changing expandedPhone) the effect re-fired and snapped
  // expandedPhone back to the deeplinked phone — trapping the user on the
  // deeplinked card. We now track "have we already handled this deeplink
  // value?" in a ref so the effect only fires once per distinct phone
  // param. Same pattern for the scroll effect so it doesn't re-scroll on
  // every 30s autorefetch.
  const searchParams = useSearchParams()
  const deeplinkPhone = searchParams.get("phone")
  // Embed mode — rendered inside the Drips-tab lead overlay (iframe). Hide
  // the page header + search + filter chips so the user sees just the
  // deep-linked card. The card itself is unchanged.
  const embedMode = searchParams.get("embed") === "1"
  const lastHandledDeeplinkRef = useRef<string | null>(null)
  const scrolledForDeeplinkRef = useRef<string | null>(null)
  useEffect(() => {
    if (!deeplinkPhone) return
    if (lastHandledDeeplinkRef.current === deeplinkPhone) return
    lastHandledDeeplinkRef.current = deeplinkPhone
    setExpandedPhone(deeplinkPhone)
  }, [deeplinkPhone])
  useEffect(() => {
    if (!deeplinkPhone || expandedPhone !== deeplinkPhone) return
    if (leads.length === 0) return
    if (scrolledForDeeplinkRef.current === deeplinkPhone) return
    scrolledForDeeplinkRef.current = deeplinkPhone
    // Wait one paint so the card is in the DOM before scrolling.
    const t = window.setTimeout(() => {
      const el = document.querySelector(`[data-lead-phone="${deeplinkPhone}"]`)
      if (el) (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" })
    }, 50)
    return () => window.clearTimeout(t)
  }, [deeplinkPhone, expandedPhone, leads.length])

  const groups = useMemo(() => groupLeads(leads), [leads])
  // Phase 7C — Part 8: keep the currently-expanded card visible regardless of
  // active filter. Without this, placing a call flips a cold lead's status
  // from "new" → "contacted" (auto-advance on first outbound), which then
  // filters the card out from under Ryan mid-call. Pin it instead.
  const filteredGroups = useMemo(() => {
    let result = groups
    if (filter !== "all") result = result.filter(g => g.status === filter)
    if (sourceFilter !== "all") result = result.filter(g => g.sourceType === sourceFilter)
    if (tempFilter !== "all") result = result.filter(g => g.temperature === tempFilter)
    if (hideDnc) result = result.filter(g => !g.isDnc)
    if (hideJunk) result = result.filter(g => !g.isJunk)
    if (hideBadNumber) result = result.filter(g => !g.isBadNumber)
    // Free-text search across name / phone (raw + last-10 digits) / email /
    // property address / notes. Trimmed + lowercase compare; phone match
    // additionally strips non-digits so "(408) 781-3058" and "4087813058"
    // and "408-781-3058" all hit the same lead.
    const q = search.trim().toLowerCase()
    if (q) {
      const qDigits = q.replace(/\D/g, "")
      result = result.filter(g => {
        if (g.name && g.name.toLowerCase().includes(q)) return true
        if (g.email && g.email.toLowerCase().includes(q)) return true
        if (g.propertyAddress && g.propertyAddress.toLowerCase().includes(q)) return true
        if (g.notes && g.notes.toLowerCase().includes(q)) return true
        if (qDigits && g.phone) {
          const phoneDigits = g.phone.replace(/\D/g, "")
          if (phoneDigits.includes(qDigits)) return true
        }
        return false
      })
    }
    if (expandedPhone && !result.some(g => g.phone === expandedPhone)) {
      const pinned = groups.find(g => g.phone === expandedPhone)
      if (pinned) result = [pinned, ...result]
    }
    return result
  }, [groups, filter, search, sourceFilter, tempFilter, hideDnc, hideJunk, hideBadNumber, expandedPhone])

  const hasActiveSecondary =
    sourceFilter !== "all" || tempFilter !== "all" || hideDnc || hideJunk || hideBadNumber

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
        // The route returns an AI-suggested subject too — wire it in (it was
        // being dropped before). Harmless for thread replies (subject unused).
        if (data.subject) setEmailSubject(prev => ({ ...prev, [group.phone]: data.subject }))
      }
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e))
    } finally {
      setDraftingFor(null)
    }
  }, [])

  const fetchSummary = useCallback(async (group: LeadGroup, opts?: { force?: boolean }) => {
    const key = group.phone
    const force = opts?.force === true
    setSummaries(prev => ({ ...prev, [key]: { text: prev[key]?.text || group.aiSummary || "", loading: true, error: null } }))
    try {
      const res = await fetch(`/api/leads/${group.mostRecentId}/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setSummaries(prev => ({ ...prev, [key]: { text: data.summary || "", loading: false, error: null } }))
      // Stamp the model's output back onto the underlying lead row so
      // groupLeads re-derives the card with the new values immediately —
      // without this we'd wait up to 30s for the autorefetch and the user
      // would see the new summary but a stale "Add name" placeholder.
      // Only stamp non-null fields so we never clobber an existing
      // hand-corrected name/address/email with null when the model didn't
      // return one (summary endpoint returns null for these when the anchor
      // row already had a value, per its hands-off rule). Temperature is NOT
      // touched here — the summary endpoint is summary-only; the badge stays
      // owned by analyzeCallTranscript / triageEmailLead.
      applyLeadEdit(prev => prev.map(l => {
        if (l.id !== group.mostRecentId) return l
        const next: Lead = {
          ...l,
          ai_summary: data.summary,
          ai_summary_generated_at: data.generated_at,
        }
        if (data.name) next.name = data.name
        if (data.property_address) next.property_address = data.property_address
        if (data.email) next.email = data.email
        // Property details — the endpoint returns the EFFECTIVE merged array
        // (post sticky-merge), so stamp it whenever present. This is what makes
        // the Property block fill in live as Ryan expands each card.
        if (Array.isArray(data.property_details)) {
          next.property_details = data.property_details as PropertyDetail[]
        }
        return next
      }))
    } catch (e) {
      setSummaries(prev => ({ ...prev, [key]: { text: prev[key]?.text || "", loading: false, error: e instanceof Error ? e.message : String(e) } }))
    }
  }, [applyLeadEdit])

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
      applyLeadEdit(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, caller_phone: normalized } : l))
      setPhoneDraft(prev => ({ ...prev, [group.phone]: "" }))
      // The cluster's group key changes from email:/thread:/id: to the phone
      // number now that it has one. extraEvents + syncedGroups are keyed by
      // the group key, so migrate them to the new key — otherwise the
      // already-synced iMessage/Gmail history orphans under the dead key and
      // vanishes from the card, and syncedGroups no longer gates the new key
      // (a re-expand would re-sync from scratch and double-render).
      if (normalized && normalized !== group.phone) {
        setExtraEvents(prev => {
          if (!(group.phone in prev)) return prev
          const next = { ...prev }
          const moved = next[group.phone]
          delete next[group.phone]
          next[normalized] = [...(next[normalized] ?? []), ...moved]
          return next
        })
        setSyncedGroups(prev => {
          if (!prev.has(group.phone)) return prev
          const next = new Set(prev)
          next.delete(group.phone)
          next.add(normalized)
          return next
        })
      }
      // Silent refresh to reconcile with the server's re-keyed cluster.
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
    applyLeadEdit(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, status } : l))
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
    applyLeadEdit(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, notes: val } : l))
    void patchLead(group.mostRecentId, { notes: val })
    // Extract a follow-up date from the note text if a timeframe is mentioned.
    void fetch(`/api/leads/${group.mostRecentId}/extract-followup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: val }),
    }).then(r => r.json()).then((data: { date?: string | null; reason?: string | null }) => {
      if (data.date) {
        applyLeadEdit(prev => prev.map(l =>
          l.id === group.mostRecentId
            ? { ...l, recommended_followup_date: data.date ?? undefined, followup_reason: data.reason ?? undefined }
            : l
        ))
      }
    }).catch(() => {})
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
      applyLeadEdit(prev => prev.filter(l => !idSet.has(l.id)))
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
    setSendingEmailFor(group.phone)
    setEmailSendError(null)
    try {
      // Two send paths:
      //  - Lead emailed in → there's an inbound email row + Gmail thread.
      //    /api/leads/email-reply threads the reply (inherits the subject).
      //  - Call-only lead with an email we captured (AI or hand) → no thread.
      //    /api/leads/[id]/send-email sends a FRESH email, so it needs a
      //    subject. Target the most-recent row in the cluster — the route
      //    reads .email off it and picks the sending mailbox.
      const emailLead = group.events.find(e => e.lead_type === "email" && !isOutbound(e))
      let res: Response
      if (emailLead) {
        res = await fetch("/api/leads/email-reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId: emailLead.id, message: text }),
        })
      } else {
        const subject = (emailSubject[group.phone] ?? "").trim()
        if (!subject) {
          setEmailSendError("Subject is required for a new email.")
          setSendingEmailFor(null)
          return
        }
        res = await fetch(`/api/leads/${group.mostRecentId}/send-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject, body: text }),
        })
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setEmailDraft(prev => ({ ...prev, [group.phone]: "" }))
      setEmailSubject(prev => ({ ...prev, [group.phone]: "" }))
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
    applyLeadEdit(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, ...patch } : l))
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
      // Cross-frame realtime: when this LeadsTab is rendered inside the Drips
      // tab's iframe overlay (embed=1), flipping is_junk / is_dnc triggers the
      // server-side halt-outreach sweep that converts pending/approved drip
      // rows to skipped. Tell the parent frame so it can refetch /api/drips
      // immediately instead of waiting up to 30s for the next poll.
      if (patch.is_junk === true || patch.is_dnc === true) {
        notifyLeadChangedToParent(group.mostRecentId, ["is_junk", "is_dnc"])
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

  // Refresh chat.db + Gmail history for the open lead. syncOnExpand normally
  // fires once per session per group (gated by syncedGroups Set) — this is
  // the manual "I just texted Susan from my phone, pull it in now" path.
  // Until inbound SMS moves to Twilio, chat.db is the canonical store for
  // iMessage/SMS Ryan sends from his Mac/iPhone, and it isn't auto-pushed
  // to Supabase.
  const [refreshingSyncFor, setRefreshingSyncFor] = useState<string | null>(null)
  async function refreshSyncForGroup(group: LeadGroup) {
    setRefreshingSyncFor(group.phone)
    try {
      // Clear the dedupe-gate AND the prior synthetic events so this re-fetch
      // can re-build the merged set without leaving duplicates from a stale
      // run sitting in extraEvents.
      setSyncedGroups(prev => {
        const next = new Set(prev); next.delete(group.phone); return next
      })
      setExtraEvents(prev => {
        const next = { ...prev }; delete next[group.phone]; return next
      })
      // syncOnExpand reads syncedGroups via the closure captured at the time
      // of its definition (useCallback dep), so we have to wait a tick for
      // the state update to settle before calling it.
      await new Promise(r => setTimeout(r, 0))
      await syncOnExpand(group)
    } finally {
      setRefreshingSyncFor(null)
    }
  }

  // Long-term nurture: for leads who said "not now, maybe in a year or two".
  // Skips the cluster's pending drips, switches them onto the slow
  // long_term_nurture campaign (first email touch at 60d), and stamps a
  // 6-month follow-up reminder. See app/api/leads/[id]/long-term-nurture.
  async function longTermNurtureGroup(group: LeadGroup) {
    const who = group.name || group.contactPhone || group.email || "this lead"
    if (!confirm(`Move ${who} to long-term nurture? Stops the current cadence, switches to slow check-ins (~60d / 120d / 180d / 240d / 365d / 540d, alternating email + iMessage), and sets a 6-month follow-up reminder.`)) return
    try {
      const res = await fetch(`/api/leads/${group.mostRecentId}/long-term-nurture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      // Embed-mode → notify the Drips tab parent so it refetches and the
      // queue rows we just skipped drop out of view immediately.
      notifyLeadChangedToParent(group.mostRecentId, ["drip_campaign_type", "recommended_followup_date"])
      void fetchLeads(true)
    } catch (e) {
      console.error("long-term-nurture failed:", e)
      alert(`Long-term nurture failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function flagDnc(group: LeadGroup) {
    if (!confirm(`Mark ${group.name || group.contactPhone || group.email || "this lead"} as DNC? This halts ALL outreach and adds them to the suppression list.`)) return
    applyLeadEdit(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, is_dnc: true, status: "dead" } : l))
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
      notifyLeadChangedToParent(group.mostRecentId, ["is_dnc"])
      void fetchLeads(true)
    } catch (e) {
      console.error("dnc failed:", e)
      void fetchLeads(true)
    }
  }

  async function clearDnc(group: LeadGroup) {
    applyLeadEdit(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, is_dnc: false } : l))
    try {
      await fetch(`/api/leads/${group.mostRecentId}/dnc`, { method: "DELETE" })
      void fetchLeads(true)
    } catch (e) {
      console.error("clear dnc failed:", e)
      void fetchLeads(true)
    }
  }

  // Promote a lead to the Relationships (BoB) sheet. Used when the caller
  // turns out to be a referral source — agent, vendor, etc. — not a seller.
  // Sets status=dead on the lead so it leaves the active queue; the
  // appended sheet row carries the lead's name/phone/AI summary forward.
  async function promoteToRelationship(group: LeadGroup, category: RelationshipCategory) {
    setPromoteError(null)
    setPromotingFor(group.phone)
    try {
      const res = await fetch(`/api/leads/${group.mostRecentId}/promote-to-relationship`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) {
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      setPromoteSuccessFor(group.phone)
      setPromoteOpenFor(null)
      // Optimistic: mark dead in local state so the card moves out of New/
      // Contacted/Active without waiting for refetch.
      applyLeadEdit(prev => prev.map(l =>
        l.id === group.mostRecentId ? { ...l, status: "dead" } : l
      ))
      window.setTimeout(() => setPromoteSuccessFor(prev => prev === group.phone ? null : prev), 4000)
      void fetchLeads(true)
    } catch (e) {
      setPromoteError(e instanceof Error ? e.message : String(e))
    } finally {
      setPromotingFor(null)
    }
  }

  async function acceptSuggestedStatus(group: LeadGroup) {
    if (!group.suggestedStatus) return
    const next = group.suggestedStatus
    applyLeadEdit(prev => prev.map(l =>
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
    applyLeadEdit(prev => prev.map(l =>
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
      {!embedMode && (<>
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

      {/* Search across name / phone / email / property / notes. Free-text;
          phone matching strips non-digits so any phone formatting works. */}
      <div className="mb-2 relative">
        <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
        <input
          type="text"
          inputMode="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, phone, email, address, or notes…"
          className="w-full pl-9 pr-9 py-2 text-sm rounded bg-zinc-950 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-200"
            aria-label="Clear search"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Phase 7D Gmail-style filter bar: lifecycle chips always visible,
          secondary filters tucked behind a Filter button, active secondary
          filters render as removable pills inline. */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {LIFECYCLE_FILTERS.map(({ key, label }) => {
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

        {sourceFilter !== "all" && (
          <button
            onClick={() => setSourceFilter("all")}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-full bg-zinc-800 text-zinc-200 border border-zinc-700 hover:border-zinc-600"
            title="Remove source filter"
          >
            {SOURCE_TYPE_FILTERS.find(f => f.key === sourceFilter)?.label}
            <X className="w-3 h-3" />
          </button>
        )}
        {tempFilter !== "all" && (
          <button
            onClick={() => setTempFilter("all")}
            className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-full border hover:border-zinc-600 ${TEMPERATURE_BADGE[tempFilter].pillClass} border-transparent`}
            title="Remove temperature filter"
          >
            {TEMPERATURE_BADGE[tempFilter].emoji} {TEMPERATURE_BADGE[tempFilter].label}
            <X className="w-3 h-3" />
          </button>
        )}
        {hideDnc && (
          <button
            onClick={() => setHideDnc(false)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-full bg-zinc-800 text-zinc-200 border border-zinc-700 hover:border-zinc-600"
            title="Stop hiding DNC"
          >
            Hide DNC <X className="w-3 h-3" />
          </button>
        )}
        {hideJunk && (
          <button
            onClick={() => setHideJunk(false)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-full bg-zinc-800 text-zinc-200 border border-zinc-700 hover:border-zinc-600"
            title="Stop hiding Junk"
          >
            Hide Junk <X className="w-3 h-3" />
          </button>
        )}
        {hideBadNumber && (
          <button
            onClick={() => setHideBadNumber(false)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-full bg-zinc-800 text-zinc-200 border border-zinc-700 hover:border-zinc-600"
            title="Stop hiding Bad #"
          >
            Hide Bad # <X className="w-3 h-3" />
          </button>
        )}

        <button
          onClick={() => setFilterSheetOpen(v => !v)}
          className={`ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full border transition-colors ${
            filterSheetOpen || hasActiveSecondary
              ? "bg-zinc-800 text-zinc-100 border-zinc-700"
              : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-100 hover:border-zinc-700"
          }`}
        >
          <SlidersHorizontal className="w-3 h-3" />
          Filter
          {hasActiveSecondary && !filterSheetOpen && (
            <span className="ml-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400" />
          )}
        </button>
      </div>

      {filterSheetOpen && (
        <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-3">
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Source</div>
            <div className="flex flex-wrap gap-1.5">
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
          </div>
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Temperature</div>
            <div className="flex flex-wrap gap-1.5">
              {TEMPERATURE_FILTERS.map(({ key, label }) => {
                const active = tempFilter === key
                return (
                  <button
                    key={key}
                    onClick={() => setTempFilter(key)}
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
          </div>
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Hide</div>
            <div className="flex flex-wrap gap-3 text-xs text-zinc-300">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={hideDnc} onChange={e => setHideDnc(e.target.checked)} className="accent-zinc-200" />
                DNC
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={hideJunk} onChange={e => setHideJunk(e.target.checked)} className="accent-zinc-200" />
                Junk
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={hideBadNumber} onChange={e => setHideBadNumber(e.target.checked)} className="accent-zinc-200" />
                Bad #
              </label>
            </div>
          </div>
        </div>
      )}

      </>)}

      {error && (
        <div className="mb-3 px-3 py-2 rounded-md bg-red-900/30 border border-red-900/50 text-sm text-red-200">
          {error}
        </div>
      )}

      {!embedMode && <CampaignMetricsStrip />}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading leads…
        </div>
      ) : filteredGroups.length === 0 ? (
        <div className="text-sm text-zinc-500 py-12 text-center">
          {groups.length === 0
            ? "No leads yet."
            : search.trim()
            ? `No leads match "${search.trim()}".`
            : `No ${LIFECYCLE_FILTERS.find(f => f.key === filter)?.label.toLowerCase() ?? filter} leads.`}
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
                // Switching cards — clear transient per-action banners so a
                // failure/success from the previously-open card doesn't
                // render under this one (these are single top-level states,
                // routed to a card only by expandedPhone).
                setSendError(null); setCallError(null); setPhoneError(null)
                setEmailSendError(null); setDeleteError(null); setPromoteError(null)
                setDraftError(null)
                setSendSuccess(null); setCallSuccess(null); setEmailSendSuccess(null)
                setExpandedPhone(willExpand ? group.phone : null)
                if (willExpand) {
                  void syncOnExpand(group)
                  // Auto-refresh the AI summary on every expand (force:true).
                  // Ryan asked for the AI notes to always be current when he
                  // opens a card instead of having to tap Refresh — so we
                  // skip the endpoint's cache and regenerate against the
                  // full cluster each open.
                  if (!summaries[group.phone]?.loading) void fetchSummary(group, { force: true })
                }
              }}
              summary={summaries[group.phone]?.text || group.aiSummary || ""}
              summaryLoading={!!summaries[group.phone]?.loading}
              summaryError={summaries[group.phone]?.error || null}
              onRefreshSummary={() => fetchSummary(group, { force: true })}
              onRefreshMessages={() => void refreshSyncForGroup(group)}
              refreshingMessages={refreshingSyncFor === group.phone}
              onDraftText={() => generateDraft(group, "imessage")}
              onDraftEmail={() => generateDraft(group, "email")}
              draftingText={draftingFor === `${group.phone}:imessage`}
              draftingEmail={draftingFor === `${group.phone}:email`}
              draftError={expandedPhone === group.phone ? draftError : null}
              onPatchField={(field, value) => patchFlagOnGroup(group, { [field]: value || null } as Partial<Lead>)}
              onSaveOffer={(amount) => patchFlagOnGroup(group, { offer_amount: amount } as Partial<Lead>)}
              onSaveProperties={(details) => patchFlagOnGroup(group, { property_details: details } as Partial<Lead>)}
              onSetStatus={(s) => setGroupStatus(group, s)}
              pendingStatus={pendingStatus}
              draftNote={draftNotes[group.phone]}
              notesDirty={
                draftNotes[group.phone] !== undefined &&
                (draftNotes[group.phone] || "") !== (group.notes ?? "")
              }
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
              emailSubject={emailSubject[group.phone] ?? ""}
              onEditEmailSubject={(v) => setEmailSubject(prev => ({ ...prev, [group.phone]: v }))}
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
              onLongTermNurture={() => longTermNurtureGroup(group)}
              onMarkBadNumber={() => patchFlagOnGroup(group, { is_bad_number: !group.isBadNumber })}
              onMarkJunk={() => {
                // 2026-05-11 — flipping junk ON also moves the lead to
                // status=dead so it leaves the New/Contacted/Active filters
                // automatically (matches DNC's behavior). Without this,
                // "marked as junk but still in New" was confusing. Toggling
                // junk OFF intentionally does NOT auto-revive status —
                // Ryan can re-set the lifecycle manually if needed.
                const willMark = !group.isJunk
                const update: Partial<Lead> = { is_junk: willMark }
                if (willMark) update.status = "dead"
                patchFlagOnGroup(group, update)
              }}
              onFlagDnc={() => flagDnc(group)}
              onClearDnc={() => clearDnc(group)}
              onAcceptSuggestion={() => acceptSuggestedStatus(group)}
              onDismissSuggestion={() => dismissSuggestedStatus(group)}
              promoteOpen={promoteOpenFor === group.phone}
              onTogglePromote={() => setPromoteOpenFor(prev => prev === group.phone ? null : group.phone)}
              onPromoteToRelationship={(cat) => promoteToRelationship(group, cat)}
              promoting={promotingFor === group.phone}
              promoteError={promotingFor === null && promoteError && expandedPhone === group.phone ? promoteError : null}
              promoteSuccess={promoteSuccessFor === group.phone}
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
  notesDirty: boolean
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
  emailSubject: string
  onEditEmailSubject: (v: string) => void
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
  onLongTermNurture: () => void
  onMarkBadNumber: () => void
  onMarkJunk: () => void
  onFlagDnc: () => void
  onClearDnc: () => void
  onAcceptSuggestion: () => void
  onDismissSuggestion: () => void
  // Promote → Relationships (Google Sheet / BoB)
  promoteOpen: boolean
  onTogglePromote: () => void
  onPromoteToRelationship: (category: RelationshipCategory) => void
  promoting: boolean
  promoteError: string | null
  promoteSuccess: boolean
  summary: string
  summaryLoading: boolean
  summaryError: string | null
  onRefreshSummary: () => void
  onRefreshMessages: () => void
  refreshingMessages: boolean
  onDraftText: () => void
  onDraftEmail: () => void
  draftingText: boolean
  draftingEmail: boolean
  draftError: string | null
  onPatchField: (field: "name" | "property_address" | "email", value: string) => void
  // Offer amount edit — separate from onPatchField because the value is a
  // number (or null to clear), not a string. PATCH /api/leads coerces.
  onSaveOffer: (amount: number | null) => void
  // Persist the full property_details array after an add / edit / remove.
  onSaveProperties: (details: PropertyDetail[]) => void
}

// Unified "next touch" indicator — the single line on a lead card that
// answers "when is this contact next being reached, and how". The soonest
// of the drip forecast / follow-up call is the headline; the other (if
// any) shows as a faint second line. Same lib/next-touch resolver that
// powers the Follow Ups tab, so the card and the worklist can't disagree.
function TouchLabel({ touch }: { touch: NextTouch }) {
  const Icon = touch.kind === "call" ? Phone : Bot
  const label = touch.kind === "call"
    ? "Call"
    : `Drip #${touch.touchNumber}${touch.channel === "email" ? " email" : ""}`
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <Icon className="w-3 h-3 shrink-0" />
      <span className="truncate">
        {label} · {describeTouchWhen(touch)}
        {touch.kind === "call" && touch.reason ? ` — ${touch.reason}` : ""}
      </span>
    </span>
  )
}

function NextTouchPill({ summary }: { summary: NextTouchSummary }) {
  if (!summary.primary) {
    return (
      <div className="text-xs text-zinc-600 inline-flex items-center gap-1.5">
        <Clock className="w-3 h-3 shrink-0" /> No touch scheduled
      </div>
    )
  }
  const urgency = classifyUrgency(summary.primary)
  const tone =
    urgency === "overdue" ? "border-red-900/50 bg-red-950/30 text-red-200"
      : urgency === "today" ? "border-amber-900/50 bg-amber-950/30 text-amber-200"
      : "border-zinc-800 bg-zinc-900/40 text-zinc-300"
  return (
    <div className={`rounded border px-3 py-1.5 text-xs flex flex-col gap-0.5 max-w-full ${tone}`}>
      <span className="inline-flex items-center gap-1.5 min-w-0">
        <Clock className="w-3 h-3 shrink-0" />
        <span className="font-medium shrink-0">Next touch</span>
        <span className="opacity-50 shrink-0">·</span>
        <TouchLabel touch={summary.primary} />
      </span>
      {summary.secondary && (
        <span className="inline-flex items-center gap-1.5 text-zinc-500 pl-[18px] min-w-0">
          <span className="shrink-0">then</span>
          <TouchLabel touch={summary.secondary} />
        </span>
      )}
    </div>
  )
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
  // Email composer gating. `hasInboundEmail` = the lead actually emailed in,
  // so there's a Gmail thread to reply on. `hasEmail` = we have an email
  // address at all — incl. one the AI pulled off a call transcript or Ryan
  // typed in. The composer shows whenever `hasEmail` is true (not just for
  // email-origin leads); a call-only lead with an email sends a FRESH email
  // (subject required) instead of a thread reply.
  const hasInboundEmail = group.events.some(e => e.lead_type === "email" && !isOutbound(e))
  const hasEmail = !!group.email
  // Unified next-touch: drip forecast + follow-up call resolved into one
  // soonest-first summary (see lib/next-touch). Drip metadata lives on the
  // intake row; flags / follow-up live on the group.
  const intakeRow = group.events.find(e => e.drip_campaign_type) || group.events[0]
  const nextTouch = resolveNextTouch({
    dripCampaignType: intakeRow?.drip_campaign_type,
    dripTouchNumber: intakeRow?.drip_touch_number,
    lastDripSentAt: intakeRow?.last_drip_sent_at,
    createdAt: intakeRow?.created_at ?? group.mostRecentEvent.created_at,
    hasPhone: !!group.contactPhone,
    status: group.status,
    isDnc: group.isDnc,
    isJunk: group.isJunk,
    recommendedFollowupDate: group.recommendedFollowupDate,
    followupReason: group.followupReason,
  })
  // Popout email editor — the inline composer is a 3-row box, too cramped for
  // a real multi-paragraph email. Expand opens a roomy modal that edits the
  // SAME draft state (lives in the parent), so opening/closing loses nothing.
  const [emailPopout, setEmailPopout] = useState(false)

  return (
    <div
      data-lead-phone={group.phone}
      className={`rounded-md border bg-zinc-950 overflow-hidden ${
        group.isDnc
          ? "border-red-900"
          : group.isJunk
          ? "border-zinc-800 opacity-70"
          : "border-zinc-800"
      }`}
    >
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
              {group.temperature && (
                <span
                  className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border shrink-0 ${TEMPERATURE_BADGE[group.temperature].badgeClass}`}
                  title={`AI temperature: ${TEMPERATURE_BADGE[group.temperature].label}`}
                >
                  {TEMPERATURE_BADGE[group.temperature].emoji} {TEMPERATURE_BADGE[group.temperature].label}
                </span>
              )}
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

          {/* Phase 7C-may8 Bug 4: AI summary moved into the timeline as a
              system entry (see <Timeline aiText … />), not a floating card. */}

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
          </div>

          {/* Phase 7C+ — editable name / property / email. Self-identification
              in voicemail bodies is the most authoritative source, but parsers
              still miss occasionally (e.g. Google Voice forwards arrive
              with name="Google Voice" until the body regex catches up).
              These inline-editable fields let Ryan correct in one tap — and
              the email field means a call-only lead can get an address added
              (by hand or by the AI analyzer) so the send-email path lights up. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
            <EditableInlineField
              value={group.name}
              placeholder="Add name"
              icon="👤"
              onSave={(v) => p.onPatchField("name", v)}
            />
            <EditableInlineField
              value={group.email}
              placeholder="Add email"
              icon="📧"
              onSave={(v) => p.onPatchField("email", v)}
            />
            <EditableInlineField
              value={group.propertyAddress}
              placeholder="Add property address"
              icon="🏠"
              onSave={(v) => p.onPatchField("property_address", v)}
            />
          </div>

          <NextTouchPill summary={nextTouch} />

          <OfferRow
            offerAmount={group.offerAmount}
            offerVerbalizedAt={group.offerVerbalizedAt}
            onSave={p.onSaveOffer}
          />

          <Timeline
            events={mergeForTimeline(group.events, p.extraEvents)}
            aiText={p.summary || group.aiNotes}
            aiLoading={p.summaryLoading}
            aiError={p.summaryError}
            temperature={group.temperature}
            onRefreshAi={p.onRefreshSummary}
            onRefreshMessages={group.contactPhone ? p.onRefreshMessages : undefined}
            refreshingMessages={p.refreshingMessages}
          />

          <PropertyBlock
            details={group.propertyDetails}
            onSave={p.onSaveProperties}
          />

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs text-zinc-500">Notes</div>
              {p.notesDirty && (
                <button
                  onMouseDown={e => { e.preventDefault(); p.onCommitNote() }}
                  className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300 px-2 py-0.5 rounded border border-emerald-800/60 bg-emerald-950/30"
                >
                  Save
                </button>
              )}
            </div>
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

          {hasEmail ? (
            // Email composer: shows whenever the lead has an email address.
            //  - hasInboundEmail → reply via Gmail API on the existing thread.
            //  - call-only lead with an email → fresh email (subject input
            //    appears below). If the lead also has a phone, an iMessage
            //    sub-composer renders too so Ryan can pick the channel.
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-xs text-zinc-500">
                  {group.suggestedReply
                    ? "💡 Suggested Reply"
                    : hasInboundEmail ? "Email Reply" : "New Email"}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setEmailPopout(true)}
                    className="text-[11px] text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1"
                    title="Expand to a full editor"
                  >
                    <Maximize2 className="w-3 h-3" />
                    Expand
                  </button>
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
              </div>
              {!hasInboundEmail && (
                <input
                  type="text"
                  value={p.emailSubject}
                  onChange={e => p.onEditEmailSubject(e.target.value)}
                  placeholder="Subject…"
                  className="w-full mb-2 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700"
                  style={{ fontSize: 16 }}
                  disabled={p.sendingEmail}
                />
              )}
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
                  disabled={p.sendingEmail || !p.emailDraft.trim() || (!hasInboundEmail && !p.emailSubject.trim())}
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

          {emailPopout && hasEmail && (
            <EmailComposerModal
              leadName={group.name || phoneDisplay || group.email || "(lead)"}
              hasInboundEmail={hasInboundEmail}
              subject={p.emailSubject}
              onEditSubject={p.onEditEmailSubject}
              body={p.emailDraft}
              onEditBody={p.onEditEmailDraft}
              onDraft={p.onDraftEmail}
              drafting={p.draftingEmail}
              onSend={p.onSendEmail}
              sending={p.sendingEmail}
              sendError={p.emailSendError}
              sendSuccess={p.emailSendSuccess}
              onClose={() => setEmailPopout(false)}
            />
          )}

          <div className="flex flex-wrap gap-1.5">
            {(["new", "contacted", "active", "nurture", "dead"] as LeadStatus[]).map(s => {
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
                {(group.contactPhone || group.email) && !group.events.some(e => e.drip_campaign_type === "long_term_nurture") && (
                  <button
                    onClick={p.onLongTermNurture}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-indigo-900/40 border border-indigo-900 text-indigo-200 hover:bg-indigo-900/60 text-xs font-medium transition-colors"
                    title="Move to slow long-term nurture (60/120/180/240/365/540 days, alternating email + iMessage) + 6-month follow-up reminder"
                  >
                    <Hourglass className="w-3.5 h-3.5" />
                    Long-Term Nurture
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
                {/* Promote → Relationships. Hidden if already promoted (notes
                    starts with the [PROMOTED → ...] marker the server writes). */}
                {(group.notes || "").startsWith("[PROMOTED → Relationships:") ? (
                  <span
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded bg-violet-900/30 border border-violet-900/60 text-violet-200 text-xs font-medium"
                    title="This lead was moved to the Relationships sheet"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    In Relationships
                  </span>
                ) : (
                  <button
                    onClick={p.onTogglePromote}
                    disabled={p.promoting}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded text-xs font-medium transition-colors ${
                      p.promoteOpen
                        ? "bg-violet-900/40 border border-violet-900 text-violet-200"
                        : "bg-zinc-900 border border-zinc-800 hover:border-violet-900/60 hover:text-violet-200 text-zinc-400"
                    }`}
                    title="Move this caller to the Relationships sheet (agents, vendors, etc.)"
                  >
                    {p.promoting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    Promote
                  </button>
                )}
              </>
            )}
          </div>

          {/* Inline category picker for Promote → Relationships. */}
          {p.promoteOpen && (
            <div className="rounded-md border border-violet-900/60 bg-violet-950/20 px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-violet-300/80 mb-1.5">
                Move to Relationships as…
              </div>
              <div className="flex flex-wrap gap-1.5">
                {RELATIONSHIP_CATEGORY_PICKER_ORDER.map(key => (
                  <button
                    key={key}
                    onClick={() => p.onPromoteToRelationship(key)}
                    disabled={p.promoting}
                    className="inline-flex items-center px-3 py-1.5 min-h-[32px] rounded-full text-xs font-medium bg-violet-900/30 border border-violet-900/60 text-violet-100 hover:bg-violet-900/60 transition-colors disabled:opacity-50"
                  >
                    {RELATIONSHIP_CATEGORY_LABELS[key]}
                  </button>
                ))}
                <button
                  onClick={p.onTogglePromote}
                  disabled={p.promoting}
                  className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[32px] rounded-full text-xs text-zinc-400 hover:text-zinc-200"
                >
                  <X className="w-3 h-3" /> Cancel
                </button>
              </div>
              {p.promoteError && (
                <div className="mt-2 text-xs text-red-300">{p.promoteError}</div>
              )}
            </div>
          )}
          {p.promoteSuccess && !p.promoteOpen && (
            <div className="text-xs text-violet-300 inline-flex items-center gap-1">
              <Check className="w-3 h-3" /> Moved to Relationships
            </div>
          )}

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

// Full-screen email editor. The inline card composer is a cramped 3-row box;
// this is the "Expand" target — a roomy modal for actually writing/editing a
// multi-paragraph email. It edits the SAME draft state passed down from
// LeadsTab (subject + body), so opening and closing it loses nothing and the
// inline composer stays in sync. Backdrop click + Escape both close (safe —
// the draft persists in the parent). Auto-closes shortly after a successful
// send so Ryan sees the confirmation, then it gets out of the way.
function EmailComposerModal(props: {
  leadName: string
  hasInboundEmail: boolean
  subject: string
  onEditSubject: (v: string) => void
  body: string
  onEditBody: (v: string) => void
  onDraft: () => void
  drafting: boolean
  onSend: () => void
  sending: boolean
  sendError: string | null
  sendSuccess: boolean
  onClose: () => void
}) {
  const {
    leadName, hasInboundEmail, subject, onEditSubject, body, onEditBody,
    onDraft, drafting, onSend, sending, sendError, sendSuccess, onClose,
  } = props

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  // Close shortly after a successful send so the confirmation is visible.
  useEffect(() => {
    if (!sendSuccess) return
    const t = setTimeout(onClose, 1200)
    return () => clearTimeout(t)
  }, [sendSuccess, onClose])

  const canSend = !sending && body.trim().length > 0 && (hasInboundEmail || subject.trim().length > 0)

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <Mail className="w-4 h-4 text-zinc-400" />
          <span className="text-zinc-100 font-medium">
            {hasInboundEmail ? "Email Reply" : "New Email"} — {leadName}
          </span>
          <button
            onClick={onDraft}
            disabled={drafting}
            className="ml-auto text-[11px] text-purple-300 hover:text-purple-200 inline-flex items-center gap-1 disabled:opacity-50"
            title="Have AI draft an email based on the conversation"
          >
            {drafting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
            {drafting ? "Drafting…" : "AI draft"}
          </button>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 overflow-y-auto">
          {!hasInboundEmail && (
            <div>
              <div className="text-xs text-zinc-500 mb-1">Subject</div>
              <input
                type="text"
                value={subject}
                onChange={e => onEditSubject(e.target.value)}
                placeholder="Subject…"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700"
                style={{ fontSize: 16 }}
                disabled={sending}
              />
            </div>
          )}
          <div>
            <div className="text-xs text-zinc-500 mb-1">Message</div>
            <textarea
              value={body}
              onChange={e => onEditBody(e.target.value)}
              placeholder="Write the email…"
              rows={16}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 resize-y leading-relaxed"
              style={{ fontSize: 16 }}
              disabled={sending}
              autoFocus
            />
          </div>
        </div>

        <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-2">
          <div className="text-xs flex-1 min-w-0 truncate">
            {sendError && <span className="text-red-300">{sendError}</span>}
            {sendSuccess && (
              <span className="text-emerald-400 inline-flex items-center gap-1">
                <Check className="w-3 h-3" /> Email sent
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
          >
            Close
          </button>
          <button
            onClick={onSend}
            disabled={!canSend}
            className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium transition-colors"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            Send Email
          </button>
        </div>
      </div>
    </div>
  )
}

// Whitespace-normalized message text for cross-source dedupe.
function normalizeMsg(m: string | null | undefined): string {
  return (m || "").replace(/\s+/g, " ").trim().toLowerCase()
}

// Is this the same message from two sources? The same email is stored
// differently depending on origin: an inbound email leads-row is
// "<subject>\n\n<body>", an outbound reply row (from /api/leads/email-reply)
// is body-only, and a Gmail-synced synthetic ALWAYS wraps "<subject>\n\n
// <body>". Email bodies themselves contain blank lines (the greeting —
// "Hi Grace,\n\n…"), so splitting subject from body on the first "\n\n" is
// unreliable and was double-rendering replies. Instead: normalize whitespace
// and treat two same-direction events as the same message when the longer
// text ends with the shorter — a subject prefix is the only legitimate
// difference between the two encodings. The length floor stops a short
// phatic reply ("ok") that happens to be a suffix from collapsing wrongly.
function sameTimelineEvent(a: Lead, b: Lead): boolean {
  if (isOutbound(a) !== isOutbound(b)) return false
  const na = normalizeMsg(a.message)
  const nb = normalizeMsg(b.message)
  if (!na || !nb) return na === nb
  if (na === nb) return true
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na]
  return short.length >= 25 && long.endsWith(short)
}

// Combine the group's authoritative events (from Supabase) with synthetic
// events merged in from chat.db / Gmail thread sync, deduping cross-source
// matches. Sorted oldest → newest so the Timeline renderer's chronological
// assumption holds. This render-time dedupe is the final gate — syncOnExpand
// also filters, but if Ryan replies after expanding, the new authoritative
// row arrives on the next fetch tick while the synthetic version lingers in
// `extraEvents`; sameTimelineEvent collapses the pair here.
function mergeForTimeline(authoritative: Lead[], synthetic: Lead[]): Lead[] {
  if (synthetic.length === 0) return authoritative
  const filtered = synthetic.filter(s => !authoritative.some(a => sameTimelineEvent(a, s)))
  return [...authoritative, ...filtered].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )
}

// Inline editable text field with a small pencil affordance. Used for
// name + property_address on the expanded LeadCard so Ryan can correct
// parser misses (e.g. "Google Voice" → "Chris Bola") in one tap. Saves
// on Enter or blur; Esc cancels.
// Offer line on the expanded lead card. Renders nothing when offerAmount
// is null. When set, shows "Offer: $800K · May 14 ✏️" with the pencil
// opening an inline edit that parses dollar inputs like "850k", "$1.2M",
// "725000". Empty save clears the offer (PATCH offer_amount=null which
// the leads PATCH route extends to also null offer_verbalized_at). The
// timestamp is set server-side on the PATCH when offer_amount is set
// without an explicit offer_verbalized_at — see app/api/leads/route.ts.
function OfferRow(props: {
  offerAmount: number | null
  offerVerbalizedAt: string | null
  onSave: (amount: number | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")

  // Parse user input ("$850k", "1.2M", "725000", "725,000") → number, or
  // null when the trimmed input is empty (= "clear the offer").
  function parseAmount(input: string): { amount: number | null; valid: boolean } {
    const trimmed = input.trim()
    if (!trimmed) return { amount: null, valid: true }
    const m = trimmed.replace(/[$,_\s]/g, "").match(/^(\d+(?:\.\d+)?)([kKmM]?)$/)
    if (!m) return { amount: null, valid: false }
    const base = parseFloat(m[1])
    const mult = m[2].toLowerCase() === "k" ? 1000 : m[2].toLowerCase() === "m" ? 1_000_000 : 1
    const val = Math.round(base * mult)
    if (!Number.isFinite(val) || val <= 0) return { amount: null, valid: false }
    return { amount: val, valid: true }
  }

  function formatAmount(n: number): string {
    if (n >= 1_000_000) {
      const m = n / 1_000_000
      return `$${m.toFixed(m % 1 === 0 ? 0 : 1)}M`
    }
    return `$${Math.round(n / 1000)}K`
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" })
  }

  // Empty state → render a low-contrast "+ Add offer" pill so Ryan has a
  // way to log an offer he made live (not picked up from a transcript).
  // PATCH /api/leads stamps offer_verbalized_at = now() server-side when
  // an amount is set without an explicit timestamp — see the route.
  if (!props.offerAmount && !editing) {
    return (
      <button
        onClick={() => { setDraft(""); setEditing(true) }}
        className="rounded border border-zinc-800 bg-zinc-950 px-3 py-1 text-[11px] text-zinc-500 inline-flex items-center gap-1.5 hover:border-amber-900/60 hover:text-amber-300 transition-colors"
        title="Log a verbalized offer (e.g. $1.2M to Candace)"
      >
        💰 <span>Add offer</span>
      </button>
    )
  }

  if (!editing) {
    return (
      <button
        onClick={() => { setDraft(props.offerAmount ? formatAmount(props.offerAmount) : ""); setEditing(true) }}
        className="rounded border border-amber-900/40 bg-amber-950/20 px-3 py-1.5 text-xs text-amber-100 inline-flex items-center gap-2 group hover:bg-amber-950/40 transition-colors max-w-full"
        title="Edit the verbalized offer amount"
      >
        <span className="font-medium">💰 Offer: {props.offerAmount ? formatAmount(props.offerAmount) : "—"}</span>
        {props.offerVerbalizedAt && (
          <span className="text-amber-300/70">· {formatDate(props.offerVerbalizedAt)}</span>
        )}
        <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-70 transition-opacity" />
      </button>
    )
  }

  const commit = () => {
    setEditing(false)
    const { amount, valid } = parseAmount(draft)
    if (!valid) return // bad input — silently revert; the existing value stays
    // Don't fire a no-op save when the value didn't actually change.
    if (amount === props.offerAmount) return
    props.onSave(amount)
  }

  return (
    <div className="rounded border border-amber-900/40 bg-amber-950/20 px-3 py-1.5 text-xs text-amber-100 inline-flex items-center gap-2 max-w-full">
      <span>💰 Offer</span>
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit() }
          else if (e.key === "Escape") { setDraft(""); setEditing(false) }
        }}
        placeholder="$850k or 1.2M (empty = clear)"
        className="bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-500 min-w-[180px]"
        style={{ fontSize: 16 }}
      />
    </div>
  )
}

function EditableInlineField(props: {
  value: string | null
  placeholder: string
  icon: string
  onSave: (value: string) => void | Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(props.value || "")
  // Re-sync the draft from props ONLY while NOT actively editing. Syncing
  // during an edit let a 30s background refetch land mid-keystroke and wipe
  // whatever the user had typed. When editing ends, the effect re-runs and
  // re-syncs so the next open starts from the current value.
  useEffect(() => {
    if (!editing) setDraft(props.value || "")
  }, [props.value, editing])

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

// Field order + labels + placeholders for the editable Property block. `label`
// (address/tag) doubles as the per-property heading in the read view, so it's
// excluded from the scannable spec rows there but is the first field in edit
// mode.
const PROPERTY_FIELD_DEFS: { key: keyof PropertyDetail; label: string; placeholder: string }[] = [
  { key: "label",          label: "Address / tag", placeholder: "e.g. 2127 Los Gatos Rd" },
  { key: "property_type",  label: "Type",          placeholder: "Duplex, single-family…" },
  { key: "units",          label: "Units",         placeholder: "2" },
  { key: "unit_mix",       label: "Unit mix",      placeholder: "1× 3bd/2ba · 1× 2bd/1ba" },
  { key: "rents",          label: "Rents",         placeholder: "$2,800 + $2,100/mo" },
  { key: "occupancy",      label: "Occupancy",     placeholder: "Both occupied, MTM" },
  { key: "square_footage", label: "Sq ft",         placeholder: "~2,400" },
  { key: "lot_size",       label: "Lot size",      placeholder: "6,000 sqft lot" },
  { key: "year_built",     label: "Year built",    placeholder: "1978" },
  { key: "notes",          label: "Notes",         placeholder: "Condition, ADU potential…" },
]

function emptyProperty(): PropertyDetail {
  return {
    label: null, property_type: null, units: null, unit_mix: null, rents: null,
    occupancy: null, square_footage: null, lot_size: null, year_built: null, notes: null,
  }
}

// Scannable + editable per-property spec block, rendered under the AI summary.
// Read view: each property shows only its filled fields as label→value rows
// (the whole point — Ryan glances and sees units / mix / rents without reading
// prose). Edit view (✎): all fields become inline inputs + a Remove button. A
// single contact can own several properties, so this is a list with + Add.
//
// Persistence model: editing/removing a field calls onSave with the full array
// (PATCH /api/leads replaces property_details). Adding a property is LOCAL only
// until a field is filled — an entirely-empty property is stripped server-side,
// so persisting it on add would make the new form vanish on the next refetch.
function PropertyBlock({
  details,
  onSave,
}: {
  details: PropertyDetail[]
  onSave: (details: PropertyDetail[]) => void
}) {
  const [items, setItems] = useState<PropertyDetail[]>(details)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  // Re-sync from props when the derived group data changes (AI fill, refetch).
  useEffect(() => { setItems(details) }, [details])

  const commit = (next: PropertyDetail[]) => {
    setItems(next)
    onSave(next)
  }
  const setField = (idx: number, key: keyof PropertyDetail, value: string) => {
    const v = value.trim()
    commit(items.map((p, i) => (i === idx ? { ...p, [key]: v || null } : p)))
  }
  const addProperty = () => {
    // Local-only — see note above. Open it straight into edit mode.
    setItems((prev) => [...prev, emptyProperty()])
    setEditingIdx(items.length)
  }
  const removeProperty = (idx: number) => {
    commit(items.filter((_, i) => i !== idx))
    setEditingIdx(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-xs text-zinc-500">
          Property details{items.length > 1 ? ` · ${items.length}` : ""}
        </div>
        <button
          type="button"
          onClick={addProperty}
          className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-200 px-2 py-0.5 rounded hover:bg-zinc-900 transition-colors"
        >
          <span className="text-sm leading-none">+</span> Add property
        </button>
      </div>

      {items.length === 0 ? (
        <div className="text-[11px] text-zinc-600 italic">
          No property details yet — they fill in automatically from calls, or add one.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((prop, idx) => {
            const isEditing = editingIdx === idx
            const heading = prop.label || prop.property_type || `Property ${idx + 1}`
            const filled = PROPERTY_FIELD_DEFS.filter((d) => d.key !== "label" && prop[d.key])
            return (
              <div key={idx} className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm leading-5">🏘️</span>
                  <span className="text-sm font-medium text-zinc-200 truncate">{heading}</span>
                  <button
                    type="button"
                    onClick={() => setEditingIdx(isEditing ? null : idx)}
                    className="ml-auto text-zinc-500 hover:text-zinc-300 inline-flex items-center"
                    title={isEditing ? "Done editing" : "Edit property"}
                  >
                    {isEditing ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3 h-3" />}
                  </button>
                </div>

                {isEditing ? (
                  <div className="space-y-1">
                    {PROPERTY_FIELD_DEFS.map((def) => (
                      <div key={def.key} className="flex items-baseline gap-2">
                        <span className="text-[11px] text-zinc-500 w-24 shrink-0">{def.label}</span>
                        <EditableInlineField
                          value={prop[def.key]}
                          placeholder={def.placeholder}
                          icon=""
                          onSave={(v) => setField(idx, def.key, v)}
                        />
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => removeProperty(idx)}
                      className="mt-1 inline-flex items-center gap-1 text-[11px] text-red-400/80 hover:text-red-300"
                    >
                      <Trash2 className="w-3 h-3" /> Remove property
                    </button>
                  </div>
                ) : filled.length > 0 ? (
                  <div className="space-y-0.5">
                    {filled.map((def) => (
                      <div key={def.key} className="flex items-baseline gap-2 text-xs">
                        <span className="text-[11px] text-zinc-500 w-24 shrink-0">{def.label}</span>
                        <span className="text-zinc-200 break-words min-w-0">{prop[def.key]}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-zinc-600 italic">No details yet — tap ✎ to add.</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Timeline(props: {
  events: Lead[]
  aiText: string | null
  aiLoading: boolean
  aiError: string | null
  temperature: Temperature | null
  onRefreshAi: () => void
  // Optional — when present, renders a "Refresh from chat.db" button in the
  // timeline header. Lets Ryan pull in iMessage/SMS sent from his phone or
  // Mac without re-opening the card. Auto-fires on first expand; this is
  // the manual re-pull for in-session updates.
  onRefreshMessages?: () => void
  refreshingMessages?: boolean
}) {
  const { events, aiText, aiLoading, aiError, temperature, onRefreshAi, onRefreshMessages, refreshingMessages } = props
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-xs text-zinc-500">Timeline</div>
        {onRefreshMessages && (
          <button
            type="button"
            onClick={onRefreshMessages}
            disabled={refreshingMessages}
            className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-200 disabled:opacity-50 px-2 py-0.5 rounded hover:bg-zinc-900 transition-colors"
            title="Pull recent iMessage/SMS history from chat.db (for messages you sent from your phone/Mac that haven't synced here yet)"
          >
            {refreshingMessages ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh messages
          </button>
        )}
      </div>
      {events.map(ev => (
        <TimelineEvent key={ev.id} ev={ev} />
      ))}
      {(aiText || aiLoading || aiError) && (
        <TimelineAiEntry
          text={aiText}
          loading={aiLoading}
          error={aiError}
          temperature={temperature}
          onRefresh={onRefreshAi}
        />
      )}
    </div>
  )
}

// Phase 7D: temperature badge on line 1 (🔥 Hot / ☀️ Warm / ❄️ Cold) followed
// by the short paragraph summary written by analyzeCallTranscript. Replaces
// the older "AI summary" label + verbose markdown bullets.
function TimelineAiEntry(props: {
  text: string | null
  loading: boolean
  error: string | null
  temperature: Temperature | null
  onRefresh: () => void
}) {
  const badge = props.temperature ? TEMPERATURE_BADGE[props.temperature] : null
  return (
    <div className="flex justify-center">
      <div className="max-w-[90%] flex items-start gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 w-full">
        <span className="text-zinc-500 text-sm leading-5">🤖</span>
        <div className="flex-1 min-w-0">
          <div className="mb-1 flex items-center gap-2">
            {badge ? (
              <span className={`px-1.5 py-0.5 text-[11px] font-semibold rounded border ${badge.badgeClass}`}>
                {badge.emoji} {badge.label}
              </span>
            ) : (
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">AI summary</span>
            )}
            <button
              onClick={props.onRefresh}
              disabled={props.loading}
              className="ml-auto text-zinc-500 hover:text-zinc-300 disabled:opacity-50 inline-flex items-center"
              title="Regenerate"
            >
              <RefreshCw className={`w-3 h-3 ${props.loading ? "animate-spin" : ""}`} />
            </button>
          </div>
          {props.text ? (
            <div className="text-sm text-zinc-300 whitespace-pre-wrap break-words">
              {props.text}
            </div>
          ) : props.loading ? (
            <div className="text-sm text-zinc-500 italic">Generating summary…</div>
          ) : props.error ? (
            <div className="text-sm text-red-300">{props.error}</div>
          ) : null}
        </div>
      </div>
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
                <div className="text-sm text-zinc-100 whitespace-pre-wrap break-words max-h-48 overflow-y-auto pr-1">
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
              <div className="text-sm text-zinc-200 bg-zinc-900 rounded px-3 py-2 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
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
              <div className="text-sm text-zinc-200 bg-zinc-900 rounded px-3 py-2 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
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
              <span className="text-red-300">{r.hot_count} 🔥</span>
              <span className="text-amber-300">{r.warm_count} ☀️</span>
              <span className="text-sky-300">{r.nurture_count} ❄️</span>
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

