"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { isOnMarket, listingChipLabel, type LeadListing } from "@/lib/listing"
import {
  Phone, PhoneOutgoing, PhoneOff, Bot, Mail, MessageSquare, Send, Pencil, X, Check,
  Clock, Loader2, RefreshCw, AlertTriangle, ChevronDown, ChevronRight,
  Sparkles, SkipForward, Eye, ExternalLink, CalendarClock, Ban, ShieldOff, FileText,
} from "lucide-react"
import { CallScriptPanel } from "./CallScriptPanel"
import { formatPhone } from "@/lib/utils"
import { handleSessionExpired } from "@/lib/session-expired"
import { splitLeadNotes, joinLeadNotes, ryanNotes } from "@/lib/lead-notes"
import type { ContactHistory, HistoryItem } from "@/lib/lead-history"
import { ReplyPlanner } from "./ReplyPlanner"
import { type Plan, type CoachTurn, requestDraft, requestCoach, executePlan, sendSuffixFor } from "@/lib/reply-client"

// Coach mode (2026-10-15): one coach turn — the gist, the prior turns, the chips.
type CoachArgs = { gist: string; turns: CoachTurn[]; plan: Plan | null }
import {
  classifyUrgency, describeTouchWhen, touchSortKey, isOwedReason, stripOwedPrefix,
  type NextTouch, type NextTouchUrgency,
} from "@/lib/next-touch"

// The merged Follow Ups tab — one queue for every contact who needs to be
// reached back out to, whether by a follow-up call, a drip message, or
// both. It replaces the separate Follow-ups + Drips tabs: same Drips-tab
// machinery (Send / Edit / Skip / Snooze / lead-card popup) with manual
// follow-up calls folded in alongside.
//
// Data comes from /api/follow-ups, which runs every contact through the
// shared lib/next-touch resolver. Each row carries a `primary` touch (the
// soonest — drives bucket placement) and an optional `secondary` (the
// other-kind touch). A contact with both a call and a drip shows ONE card
// with both touch blocks under one header.

interface ContactRow {
  clusterKey: string
  leadId: string
  dripLeadId: string | null
  followupLeadId: string | null
  name: string | null
  phone: string | null
  email: string | null
  gmailThreadId: string | null
  source: string | null
  propertyAddress: string | null
  listing?: LeadListing | null
  status: string
  temperature: "hot" | "warm" | "cold" | null
  notes: string | null
  aiSummary: string | null
  emailReplyLeadId: string | null
  stage?: "closed" | "pending" | "offer" | "appointment" | "lead" | null
  history?: ContactHistory
  primary: NextTouch
  secondary: NextTouch | null
  // They texted / left a voicemail / missed-called this week and Ryan hasn't
  // reached out since — the card sits in the Replied section on top.
  replied?: { at: string; kind: string; text: string | null } | null
}

interface DripCard {
  id: string
  lead_id: string
  touch_number: number
  channel: string
  message: string
  subject: string | null
  status: string
  created_at: string
  sent_at: string | null
  error: string | null
  name: string | null
  caller_phone: string | null
  email: string | null
}

interface FollowUpsPayload {
  rows: ContactRow[]
  failed: DripCard[]
  recentSent: DripCard[]
  meta: { rowCount: number; sentHistoryDays: number; failedHistoryDays: number; generatedAt: string }
}

const TEMP_BADGE: Record<"hot" | "warm" | "cold", { emoji: string; cls: string }> = {
  hot:  { emoji: "🔥", cls: "text-red-300" },
  warm: { emoji: "☀️", cls: "text-amber-300" },
  cold: { emoji: "❄️", cls: "text-sky-300" },
}

// Worklist sort within a bucket: calls before drips, owed follow-ups (Ryan
// promised the seller a deliverable — "Owed:" reason) ahead of the rest,
// then hot→warm→cold, then soonest-due. (Ryan's call: order the day's work
// by temperature; a promise he made outranks temperature.)
const TEMP_RANK: Record<string, number> = { hot: 0, warm: 1, cold: 2 }
function tempRank(t: string | null): number {
  return t ? TEMP_RANK[t] ?? 3 : 3
}
function sortWorklist(rows: ContactRow[]): ContactRow[] {
  return [...rows].sort((a, b) => {
    const k = (a.primary.kind === "call" ? 0 : 1) - (b.primary.kind === "call" ? 0 : 1)
    if (k !== 0) return k
    const owed = Number(isOwedReason(b.primary.reason)) - Number(isOwedReason(a.primary.reason))
    if (owed !== 0) return owed
    const t = tempRank(a.temperature) - tempRank(b.temperature)
    if (t !== 0) return t
    // Owners whose property is already listed on the MLS go last — Ryan
    // calls them after everyone else (2026-10-30).
    const listed = Number(isOnMarket(a.listing)) - Number(isOnMarket(b.listing))
    if (listed !== 0) return listed
    return touchSortKey(a.primary) - touchSortKey(b.primary)
  })
}

function addDaysToDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${dd}`
}

// Interval picker for the call "Done" button — matches the old Follow-ups
// tab. "No follow-up" is the only option that clears the date.
const INTERVAL_OPTIONS: { key: string; label: string; days?: number; months?: number }[] = [
  { key: "1w", label: "1 week", days: 7 },
  { key: "1mo", label: "1 month", months: 1 },
  { key: "3mo", label: "3 months", months: 3 },
  { key: "6mo", label: "6 months", months: 6 },
  { key: "none", label: "No follow-up" },
]
function dateFromInterval(opt: { days?: number; months?: number }): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  if (opt.days) d.setDate(d.getDate() + opt.days)
  if (opt.months) d.setMonth(d.getMonth() + opt.months)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${dd}`
}

// Snooze target for a follow-up call. Pushes out N days from TODAY when the
// follow-up is already overdue (or due today), else from its current future
// date. Adding days to a stale overdue date would land right back in the
// past — so a 1-3 day snooze on an old lead never actually hid it.
function snoozeFollowupDate(currentDue: string, days: number): string {
  const today = dateFromInterval({})
  return addDaysToDate(currentDue > today ? currentDue : today, days)
}

function relativeFromNow(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(diffMs)
  const past = diffMs < 0
  const m = Math.round(abs / 60000)
  if (m < 60) return past ? `${m}m ago` : `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return past ? `${h}h ago` : `in ${h}h`
  const d = Math.round(h / 24)
  if (d < 14) return past ? `${d}d ago` : `in ${d}d`
  return past ? `${Math.round(d / 7)}w ago` : `in ${Math.round(d / 7)}w`
}

// Build the lead-card overlay key. MUST match groupLeads()'s key rule in
// LeadsTab — phone → thread:<gmail_thread_id> → email:<addr> — or the
// deep-linked card won't be found (e.g. an email lead with a Gmail thread
// is keyed `thread:…`, not `email:…`).
function leadOverlayKey(row: { phone: string | null; gmailThreadId: string | null; email: string | null }): string | null {
  if (row.phone) return row.phone
  if (row.gmailThreadId) return `thread:${row.gmailThreadId}`
  if (row.email) return `email:${row.email.toLowerCase()}`
  return null
}
function dripOverlayKey(card: { caller_phone: string | null; email: string | null }): string | null {
  if (card.caller_phone) return card.caller_phone
  if (card.email) return `email:${card.email.toLowerCase()}`
  return null
}

// Engine skip reasons (drip-engine.js processLead) → human-readable toast.
// Scheduling skips (not_due / upcoming_call_followup) can't occur on a manual
// Prepare — the engine's --now override bypasses them — so these are the
// safety-check reasons that legitimately survive an explicit click.
function prepareSkipLabel(body: { outcome?: string; reason?: string }): string {
  if (body.outcome === "not_eligible") return "No draft — lead is no longer drip-eligible"
  const reason = body.reason || ""
  if (reason.startsWith("hold:")) return "No draft — recent conversation activity, drip held"
  if (reason === "pending_queued") return "A draft is already queued for this lead"
  if (reason === "hard_stop") return "Lead asked to stop — flagged DNC, no draft"
  if (reason === "stop_status") return "No draft — lead status halts drips"
  if (reason === "no_more_touches") return "Campaign finished — no touches left"
  if (reason === "generation_failed") return "Draft generation failed — try again"
  if (reason === "channel_email_no_address") return "Next touch is email but the lead has no email address"
  if (reason === "channel_imessage_no_phone") return "Next touch is a text but the lead has no phone"
  if (reason === "bad_number_no_email_remaining") return "Number flagged bad and no email touches remain"
  return reason ? `No draft — engine skipped (${reason})` : "No draft — engine skipped this lead"
}

// ---- on-call pins ---------------------------------------------------------
// Tapping Call registers the touch server-side right away (drip skipped,
// follow-up consumed), so the next refetch reschedules or drops the contact — the card
// vanished while Ryan was still dialing and he had to hunt for them in Leads
// (2026-11-02). A placed call now pins a snapshot of the card where it was,
// showing the line the lead sees, until Ryan taps End call. Kept in
// localStorage so a refresh mid-call doesn't lose it; pins expire after a
// few hours in case End call is never tapped.
// `leadId` is the outbound call row /api/leads/call created — the script
// panel saves the script on it so the post-call rater sees what was shown.
interface OnCallPin { row: ContactRow; from: string | null; at: number; leadId?: string | null }
const ON_CALL_KEY = "mc.followups.onCall"
const ON_CALL_TTL_MS = 3 * 60 * 60 * 1000

function loadOnCallPins(): Record<string, OnCallPin> {
  if (typeof window === "undefined") return {}
  try {
    const raw = JSON.parse(window.localStorage.getItem(ON_CALL_KEY) || "{}") as Record<string, OnCallPin>
    const cutoff = Date.now() - ON_CALL_TTL_MS
    return Object.fromEntries(Object.entries(raw).filter(([, p]) => p && p.row && p.at > cutoff))
  } catch {
    return {}
  }
}

// While a card is pinned, its snapshot replaces whatever the server now says
// about that contact. The call reschedules the next touch (a drip forecast
// days out), so the fresh row moved to the collapsed "upcoming" section —
// the card still vanished from where Ryan was looking (2026-11-02). The
// snapshot keeps its old fields, so it buckets and sorts exactly as before.
function keepPinnedRows(next: ContactRow[], pins: Record<string, OnCallPin>): ContactRow[] {
  const pinned = Object.values(pins).map(p => p.row)
  if (pinned.length === 0) return next
  return [...next.filter(r => !pins[r.clusterKey]), ...pinned]
}

export function FollowUpsTab() {
  const [data, setData] = useState<FollowUpsPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [undoBar, setUndoBar] = useState<{ text: string; run: () => Promise<void> } | null>(null)
  useEffect(() => {
    if (!undoBar) return
    const t = window.setTimeout(() => setUndoBar(null), 12000)
    return () => window.clearTimeout(t)
  }, [undoBar])
  // Card-level busy flag, keyed by clusterKey (or drip-queue id for the
  // collapsed Failed section).
  const [actingOn, setActingOn] = useState<string | null>(null)
  // Inline drip-message edits, keyed by drip-queue id.
  const [editing, setEditing] = useState<Map<string, { message: string; subject: string }>>(new Map())
  // Which call card has its "Done" interval picker open (clusterKey).
  const [intervalOpenFor, setIntervalOpenFor] = useState<string | null>(null)
  const [leadOverlay, setLeadOverlay] = useState<string | null>(null)
  const [sentPopout, setSentPopout] = useState<DripCard | null>(null)
  // Manual-outreach compose popup — Email or Text a contact your way.
  const [composeFor, setComposeFor] = useState<{ row: ContactRow; channel: "email" | "text" } | null>(null)
  // Collapsed sections — Today's work is the default focus; the rest open
  // on demand.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  // Cards pinned on screen during a call, keyed by clusterKey. The ref lets
  // the (stable) fetchData read the current pins.
  const [onCall, setOnCall] = useState<Record<string, OnCallPin>>({})
  const onCallRef = useRef<Record<string, OnCallPin>>({})
  useEffect(() => {
    const pins = loadOnCallPins()
    onCallRef.current = pins
    setOnCall(pins)
  }, [])
  function updateOnCall(fn: (prev: Record<string, OnCallPin>) => Record<string, OnCallPin>) {
    const next = fn(onCallRef.current)
    onCallRef.current = next
    setOnCall(next)
    try { window.localStorage.setItem(ON_CALL_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  }

  // Sales Coach scripts take Opus ~15 s; Ryan saw the panel fill 5–6 s into
  // a call (2026-11-02). Warm the server cache for the call-due cards as
  // soon as the queue loads, two at a time, each phone once per session —
  // /api/coach/script then answers the tap from the cached copy.
  const prefetchedScripts = useRef<Set<string>>(new Set())
  const prefetchScripts = useCallback((rows: ContactRow[]) => {
    // Only calls due today or overdue — scripts for calls months out cost an
    // Opus run each and went stale before the call (audit 2026-11-05).
    const phones = rows
      .filter(r => r.phone && r.primary.kind === "call" && classifyUrgency(r.primary) !== "soon" && classifyUrgency(r.primary) !== "future")
      .map(r => r.phone as string)
      .filter(p => !prefetchedScripts.current.has(p))
      .slice(0, 8)
    if (!phones.length) return
    phones.forEach(p => prefetchedScripts.current.add(p))
    const run = async (queue: string[]) => {
      for (const phone of queue) {
        try {
          await fetch("/api/coach/script", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) })
        } catch { /* best effort — the tap generates on demand */ }
      }
    }
    void run(phones.filter((_, i) => i % 2 === 0))
    void run(phones.filter((_, i) => i % 2 === 1))
  }, [])

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await fetch("/api/follow-ups", { cache: "no-store" })
      if (handleSessionExpired(res)) return
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const payload = await res.json() as FollowUpsPayload
      setData({ ...payload, rows: keepPinnedRows(payload.rows, onCallRef.current) })
      prefetchScripts(payload.rows)
      // Only clear the error banner on an explicit (non-silent) load —
      // initial mount or a manual Refresh. A SILENT refetch (the 30s poll,
      // or the refetch fired right after a send) must NOT wipe an action
      // error: that was the "blink, no message sent" bug — a stale-drip 409
      // set the banner, the immediate silent refetch cleared it a split
      // second later, so Ryan saw a flash and no explanation.
      if (!silent) setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 30s refresh only while the tab is on screen; coming back refreshes at once.
  useEffect(() => {
    void fetchData()
    const id = setInterval(() => { if (document.visibilityState === "visible") void fetchData(true) }, 30000)
    function onVisible() { if (document.visibilityState === "visible") void fetchData(true) }
    document.addEventListener("visibilitychange", onVisible)
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible) }
  }, [fetchData])

  // The lead-card popup is an iframe; when Ryan flips a flag inside it the
  // server sweeps the cluster. Refetch on its postMessage instead of
  // waiting for the 30s poll.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      if (e.data && typeof e.data === "object" && e.data.type === "lead-changed") void fetchData(true)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [fetchData])

  function showToast(text: string, ms = 3500) {
    setToast(text)
    window.setTimeout(() => setToast(prev => (prev === text ? null : prev)), ms)
  }

  // Drop a row from the visible list immediately; the next refetch is the
  // source of truth (a both-row with a remaining touch reappears).
  // Any action that clears the card also ends its on-call pin.
  function dropRow(clusterKey: string) {
    if (onCallRef.current[clusterKey]) {
      updateOnCall(prev => {
        const next = { ...prev }
        delete next[clusterKey]
        return next
      })
    }
    setData(prev => (prev ? { ...prev, rows: prev.rows.filter(r => r.clusterKey !== clusterKey) } : prev))
  }

  // ---- drip actions -------------------------------------------------------

  async function sendDrip(row: ContactRow, queueId: string, opts?: { force?: boolean }) {
    const force = opts?.force === true
    setActingOn(row.clusterKey)
    try {
      const res = await fetch(`/api/drips/${queueId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      })
      const body = await res.json().catch(() => ({}))
      // Server says the draft is stale (contact had non-drip activity since
      // it was written). Surface it loudly instead of silently dropping the
      // row — the stale-drip UI already gives the user Regenerate / Send
      // anyway / Skip; this catches the race where stale flips true between
      // fetch and click on a row the badge didn't cover yet.
      if (res.status === 409 && (body as { stale?: boolean })?.stale) {
        // Stale draft. Mark the row stale IN PLACE so the DripBlock shows the
        // Regenerate / Send anyway / Skip controls and the error banner stays
        // put. We deliberately do NOT refetch here — the old code fired a
        // silent refetch that immediately cleared this very banner, producing
        // the "blink with no explanation".
        setErr((body as { error?: string })?.error || "Contact had activity since this was drafted — Send anyway or Skip.")
        setData(prev => prev ? {
          ...prev,
          rows: prev.rows.map(r => {
            if (r.clusterKey !== row.clusterKey) return r
            const mark = (t: NextTouch | null) =>
              t && t.queueId === queueId ? { ...t, stale: true } : t
            return { ...r, primary: mark(r.primary)!, secondary: mark(r.secondary) }
          }),
        } : prev)
        return
      }
      if (!res.ok && res.status !== 202) throw new Error((body as { error?: string })?.error || `HTTP ${res.status}`)
      // The route returns `triggered:false` when it couldn't reach the send
      // engine right now — the row is approved and the hourly pass will send
      // it, so say so honestly instead of a false "Sent ✓".
      const triggered = (body as { triggered?: boolean })?.triggered !== false
      if (triggered) {
        showToast(force ? "Sending anyway ✓" : "Sent ✓")
        dropRow(row.clusterKey)
      } else {
        showToast("Queued — sends within the hour (send engine wasn't reachable just now)")
      }
      setTimeout(() => void fetchData(true), 6000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  // "Regenerate" on a stale queued drip — skip the stale draft and ask the
  // engine to write a fresh one that reflects the conversation as it stands
  // now. Two-step: skip + prepare. The engine's hasPendingQueueRow check
  // would otherwise refuse to draft alongside an existing pending row.
  async function regenerateDrip(row: ContactRow, queueId: string) {
    if (!row.dripLeadId) return
    setActingOn(row.clusterKey)
    try {
      const skipRes = await fetch("/api/leads/drip-queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: queueId, action: "skip" }),
      })
      if (!skipRes.ok) {
        const body = await skipRes.json().catch(() => ({}))
        throw new Error((body as { error?: string })?.error || `HTTP ${skipRes.status}`)
      }
      const prepRes = await fetch("/api/drips/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: row.dripLeadId }),
      })
      const body = await prepRes.json().catch(() => ({}))
      if (!prepRes.ok && prepRes.status !== 202) throw new Error((body as { error?: string })?.error || `HTTP ${prepRes.status}`)
      handlePrepareOutcome(body as { outcome?: string; reason?: string }, "Fresh draft ready — card is in “Ready to send” at the top")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  async function queueAction(row: ContactRow, queueId: string, action: "skip" | "snooze", days?: 1 | 3 | 7) {
    setActingOn(row.clusterKey)
    dropRow(row.clusterKey)
    try {
      const res = await fetch("/api/leads/drip-queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: queueId, action, ...(days ? { days } : {}) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      void fetchData(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void fetchData(true)
    } finally {
      setActingOn(null)
    }
  }

  // "Not right" on a queued drip — redraft through the shared reply engine
  // with Ryan's one-sentence why; the queued text is replaced in place.
  async function redraftDrip(row: ContactRow, queueId: string, why?: string) {
    setActingOn(row.clusterKey)
    try {
      const res = await fetch(`/api/drips/${queueId}/redraft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ why: why ?? null }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((body as { error?: string })?.error || `HTTP ${res.status}`)
      const item = (body as { item?: { message?: string; subject?: string | null } }).item
      if (!item?.message) return
      setData(prev => {
        if (!prev) return prev
        return {
          ...prev,
          rows: prev.rows.map(r => {
            if (r.clusterKey !== row.clusterKey) return r
            const patch = (t: NextTouch | null): NextTouch | null =>
              t && t.queueId === queueId ? { ...t, message: item.message ?? t.message, subject: item.subject ?? t.subject ?? null, stale: false } : t
            return { ...r, primary: patch(r.primary)!, secondary: patch(r.secondary) }
          }),
        }
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  // Coach on a queued drip — Ryan's gist through /api/reply/coach with the
  // drip_queue id; the route writes the coached text into the pending row.
  const [dripCoachRead, setDripCoachRead] = useState<Record<string, string | null>>({})
  async function coachDrip(row: ContactRow, queueId: string, args: CoachArgs): Promise<boolean> {
    setActingOn(row.clusterKey)
    try {
      const data = await requestCoach({
        leadId: row.leadId,
        channel: row.primary?.queueId === queueId && row.primary.channel === "email" ? "email" : row.secondary?.queueId === queueId && row.secondary.channel === "email" ? "email" : "sms",
        surface: "drip",
        gist: args.gist,
        turns: args.turns,
        plan: args.plan,
        dripQueueId: queueId,
      })
      setDripCoachRead(prev => ({ ...prev, [queueId]: data.read || null }))
      const item = data.item
      if (!item?.message) return true
      setData(prev => {
        if (!prev) return prev
        return {
          ...prev,
          rows: prev.rows.map(r => {
            if (r.clusterKey !== row.clusterKey) return r
            const patch = (t: NextTouch | null): NextTouch | null =>
              t && t.queueId === queueId ? { ...t, message: item.message ?? t.message, subject: item.subject ?? t.subject ?? null, stale: false } : t
            return { ...r, primary: patch(r.primary)!, secondary: patch(r.secondary) }
          }),
        }
      })
      return true
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setActingOn(null)
    }
  }

  async function saveEdit(row: ContactRow, queueId: string) {
    const draft = editing.get(queueId)
    if (!draft) return
    setActingOn(row.clusterKey)
    try {
      const res = await fetch("/api/leads/drip-queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: queueId, action: "edit", message: draft.message, subject: draft.subject }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      setData(prev => {
        if (!prev) return prev
        return {
          ...prev,
          rows: prev.rows.map(r => {
            if (r.clusterKey !== row.clusterKey) return r
            const patch = (t: NextTouch | null): NextTouch | null =>
              t && t.queueId === queueId ? { ...t, message: draft.message, subject: draft.subject || null } : t
            return { ...r, primary: patch(r.primary)!, secondary: patch(r.secondary) }
          }),
        }
      })
      setEditing(prev => {
        const next = new Map(prev)
        next.delete(queueId)
        return next
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  // The prepare route waits for the engine (can take ~10-60s while Haiku
  // writes the draft) and returns the engine's outcome, so a skip is never
  // silent. The button spinner (actingOn) covers the wait.
  function handlePrepareOutcome(body: { outcome?: string; reason?: string }, readyMsg: string) {
    if (body.outcome === "queued") {
      showToast(readyMsg)
      void fetchData(true)
    } else if (body.outcome === "skipped" || body.outcome === "not_eligible") {
      // A skip means the click produced nothing — give the reason time to read.
      showToast(prepareSkipLabel(body), 8000)
      void fetchData(true)
    } else {
      // Old sidecar build (fire-and-forget 202) or unparseable outcome —
      // assume the engine is still drafting in the background.
      showToast("Drafting drip — it'll appear ready to send")
      setTimeout(() => void fetchData(true), 8000)
    }
  }

  async function prepareForecast(row: ContactRow) {
    if (!row.dripLeadId) return
    setActingOn(row.clusterKey)
    try {
      const res = await fetch("/api/drips/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: row.dripLeadId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok && res.status !== 202) throw new Error(body?.error || `HTTP ${res.status}`)
      handlePrepareOutcome(body, "Draft ready — card moved to “Ready to send” at the top")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  async function skipForecast(row: ContactRow) {
    if (!row.dripLeadId) return
    setActingOn(row.clusterKey)
    dropRow(row.clusterKey)
    try {
      const res = await fetch("/api/drips/forecast-skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: row.dripLeadId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      void fetchData(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void fetchData(true)
    } finally {
      setActingOn(null)
    }
  }

  // ---- call actions -------------------------------------------------------

  async function placeCall(row: ContactRow) {
    if (!row.phone) return
    setActingOn(row.clusterKey)
    try {
      const res = await fetch("/api/leads/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: row.phone, source: row.source }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`)
      const from: string | null = body.callerId || body.from || null
      const leadId: string | null = typeof body.leadId === "string" ? body.leadId : null
      updateOnCall(prev => ({ ...prev, [row.clusterKey]: { row, from, at: Date.now(), leadId } }))
      showToast(from ? `Calling from ${formatPhone(from) ?? from}` : "Calling — ringing your cell")
    } catch (e) {
      setErr(`Call failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setActingOn(null)
    }
  }

  // End call — just unpins the card. The call already registered as a touch
  // and the call analysis schedules the next follow-up; the refetch shows
  // the card again only if something is genuinely still due.
  function endCall(row: ContactRow) {
    dropRow(row.clusterKey)
    void fetchData(true)
  }

  // manualTouch=true tells the API this came from a completed call (Done) —
  // it resets the contact's drip cadence. Snooze leaves it false: a snooze
  // is "not yet", not "I handled this".
  async function patchFollowup(
    row: ContactRow,
    date: string | null,
    reason: string | null,
    manualTouch = false,
  ) {
    if (!row.followupLeadId) return
    const res = await fetch("/api/leads", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: row.followupLeadId,
        recommended_followup_date: date,
        ...(reason !== undefined ? { followup_reason: reason } : {}),
        ...(manualTouch ? { manual_touch: true } : {}),
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body?.error || `HTTP ${res.status}`)
    }
  }

  // Snooze is contact-level: one Snooze defers BOTH the follow-up call and
  // the queued drip, so a lead with both touches can't resurface on the
  // other front the moment one of them is snoozed.
  async function snoozeContact(row: ContactRow, days: number) {
    setActingOn(row.clusterKey)
    dropRow(row.clusterKey)
    try {
      const ops: Promise<unknown>[] = []
      const callTouch =
        row.primary.kind === "call" ? row.primary
          : row.secondary?.kind === "call" ? row.secondary : null
      if (callTouch && row.followupLeadId) {
        ops.push(patchFollowup(row, snoozeFollowupDate(callTouch.due, days), undefined as unknown as string))
      }
      const dripTouch =
        row.primary.kind === "drip" ? row.primary
          : row.secondary?.kind === "drip" ? row.secondary : null
      if (dripTouch?.queueId) {
        ops.push(
          fetch("/api/leads/drip-queue", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: dripTouch.queueId, action: "snooze", days }),
          }).then(async (res) => {
            if (!res.ok) {
              const b = await res.json().catch(() => ({}))
              throw new Error(b?.error || `HTTP ${res.status}`)
            }
          })
        )
      }
      await Promise.all(ops)
      void fetchData(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void fetchData(true)
    } finally {
      setActingOn(null)
    }
  }

  // "Done" on a call — always opens the interval picker so Ryan explicitly
  // sets the next check-in (1w / 1mo / 3mo / 6mo / None). See applyInterval.
  function doneCall(row: ContactRow) {
    setIntervalOpenFor(prev => (prev === row.clusterKey ? null : row.clusterKey))
  }

  async function applyInterval(row: ContactRow, opt: { key: string; label: string; days?: number; months?: number }) {
    setIntervalOpenFor(null)
    setActingOn(row.clusterKey)
    dropRow(row.clusterKey)
    try {
      // "Done" is a completed call — a manual touch. Reset the drip cadence
      // (manualTouch=true) so a stale drip doesn't drag the contact straight
      // back to the top of the worklist.
      if (opt.key === "none") {
        await patchFollowup(row, null, null, true)
      } else {
        await patchFollowup(row, dateFromInterval(opt), `Manual — ${opt.label}`, true)
      }
      void fetchData(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void fetchData(true)
    } finally {
      setActingOn(null)
    }
  }

  // Park a lead on autopilot (2026-11-05, replaces Long-term nurture): the
  // 8 fixed check-in texts in scripts/autopilot.js. The card leaves the list
  // at once; an Undo bar restores the reminder + drip it had.
  async function autopilot(row: ContactRow) {
    setActingOn(row.clusterKey)
    dropRow(row.clusterKey)
    try {
      const res = await fetch(`/api/leads/${row.leadId}/autopilot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "on" }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      const who = row.name || row.phone || "This lead"
      setUndoBar({
        text: `${who} is on autopilot — first text goes out the next weekday afternoon.`,
        run: async () => {
          await fetch(`/api/leads/${row.leadId}/autopilot`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "undo", undo: body.undo }),
          })
          void fetchData(true)
        },
      })
      void fetchData(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void fetchData(true)
    } finally {
      setActingOn(null)
    }
  }

  // Change a lead's lifecycle status, or flag it junk / DNC, straight from
  // the worklist card. Lifecycle relabels (contacted/active/nurture/new) keep
  // the contact in the queue and just update the badge; the "exit" choices
  // (dead, junk, DNC) run the PATCH route's haltOutreachForCluster — which
  // skips every queued drip + clears the follow-up date across the cluster —
  // so the card drops off the list entirely. Writes to the representative row
  // (row.leadId), the same row status edits target elsewhere.
  async function changeStatus(
    row: ContactRow,
    choice: { status?: string; flag?: "is_junk" | "is_dnc" }
  ) {
    const halts = choice.flag != null || choice.status === "dead"
    setActingOn(row.clusterKey)
    if (halts) {
      dropRow(row.clusterKey)
    } else if (choice.status) {
      // Optimistic relabel — the badge flips immediately, refetch confirms.
      setData(prev => prev ? {
        ...prev,
        rows: prev.rows.map(r => r.clusterKey === row.clusterKey ? { ...r, status: choice.status! } : r),
      } : prev)
    }
    const payload: Record<string, unknown> = { id: row.leadId }
    if (choice.flag) payload[choice.flag] = true
    if (choice.status) payload.status = choice.status
    try {
      const res = await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((body as { error?: string })?.error || `HTTP ${res.status}`)
      const label =
        choice.flag === "is_junk" ? "Marked junk"
          : choice.flag === "is_dnc" ? "Marked Do-Not-Contact"
            : choice.status === "dead" ? "Marked dead"
              : `Status → ${choice.status}`
      showToast(`${label}${halts ? " — pulled from follow-ups + drips" : ""}`)
      void fetchData(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void fetchData(true)
    } finally {
      setActingOn(null)
    }
  }

  // Save the card's inline note. Optimistic — the textarea already shows the
  // text; PATCH persists it to the representative row and a failure refetches
  // to restore truth. No actingOn flag so saving a note doesn't disable the
  // card's other buttons.
  async function saveNotes(row: ContactRow, notes: string) {
    setData(prev => prev ? {
      ...prev,
      rows: prev.rows.map(r => r.clusterKey === row.clusterKey ? { ...r, notes: notes || null } : r),
    } : prev)
    try {
      const res = await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.leadId, notes: notes || null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string })?.error || `HTTP ${res.status}`)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void fetchData(true)
    }
  }

  // ---- failed-section actions --------------------------------------------

  async function retryFailed(id: string) {
    setActingOn(id)
    try {
      const res = await fetch(`/api/drips/${id}/send`, { method: "POST" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok && res.status !== 202) throw new Error(body?.error || `HTTP ${res.status}`)
      setData(prev => (prev ? { ...prev, failed: prev.failed.filter(c => c.id !== id) } : prev))
      setTimeout(() => void fetchData(true), 6000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  async function dismissFailed(id: string) {
    setActingOn(id)
    setData(prev => (prev ? { ...prev, failed: prev.failed.filter(c => c.id !== id) } : prev))
    try {
      const res = await fetch("/api/leads/drip-queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "skip" }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void fetchData(true)
    } finally {
      setActingOn(null)
    }
  }

  // ---- bucketing ----------------------------------------------------------

  const buckets = useMemo(() => {
    const now = new Date()
    const out: Record<NextTouchUrgency, ContactRow[]> = { overdue: [], today: [], soon: [], future: [] }
    // Queued drafts get their own pinned section instead of urgency
    // bucketing. A queued drip's `due` is the moment the engine wrote it,
    // so an overdue forecast that Ryan clicks Prepare on would otherwise
    // jump from Overdue down into Today mid-workflow — the card "vanishes"
    // from where he was looking. Ready-to-send is also the highest-value
    // pile (one click each), so it always renders first.
    const ready: ContactRow[] = []
    // Replied (2026-11-05): someone wrote back and hasn't heard from Ryan —
    // the most valuable cards, so they render first whatever their dates say.
    const replied: ContactRow[] = []
    for (const r of data?.rows ?? []) {
      if (r.replied) replied.push(r)
      else if (r.primary.kind === "drip" && r.primary.isQueued) ready.push(r)
      else out[classifyUrgency(r.primary, now)].push(r)
    }
    replied.sort((a, b) => (b.replied?.at ?? "").localeCompare(a.replied?.at ?? ""))
    // The server only sends what's due now. A card that's later than today is
    // one Ryan just called (pinned until End call) — it stays under Today
    // where he was working rather than vanishing.
    return {
      replied,
      ready: sortWorklist(ready),
      overdue: sortWorklist(out.overdue),
      today: sortWorklist([...out.today, ...out.soon, ...out.future]),
    }
  }, [data])

  if (!data && loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-500 py-12">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading follow-ups…
      </div>
    )
  }
  if (!data) {
    return <div className="text-sm text-red-300 py-12">{err ?? "Failed to load follow-ups."}</div>
  }

  const dueCount = buckets.replied.length + buckets.ready.length + buckets.overdue.length + buckets.today.length
  const cardProps = {
    actingOn, editing, intervalOpenFor, onCall,
    onEndCall: endCall,
    onOpenLead: (row: ContactRow) => { const k = leadOverlayKey(row); if (k) setLeadOverlay(k) },
    onSendDrip: sendDrip,
    onRegenerateDrip: regenerateDrip,
    onRedraftDrip: redraftDrip,
    onCoachDrip: coachDrip,
    dripCoachRead,
    onQueueAction: queueAction,
    onStartEdit: (queueId: string, t: NextTouch) =>
      setEditing(prev => new Map(prev).set(queueId, { message: t.message ?? "", subject: t.subject ?? "" })),
    onChangeEdit: (queueId: string, field: "message" | "subject", value: string) =>
      setEditing(prev => {
        const next = new Map(prev)
        const cur = next.get(queueId) ?? { message: "", subject: "" }
        next.set(queueId, { ...cur, [field]: value })
        return next
      }),
    onCancelEdit: (queueId: string) =>
      setEditing(prev => {
        const next = new Map(prev)
        next.delete(queueId)
        return next
      }),
    onSaveEdit: saveEdit,
    onPrepare: prepareForecast,
    onSkipForecast: skipForecast,
    onPlaceCall: placeCall,
    onSnoozeContact: snoozeContact,
    onDoneCall: doneCall,
    onPickInterval: applyInterval,
    onEmail: (row: ContactRow) => setComposeFor({ row, channel: "email" }),
    onText: (row: ContactRow) => setComposeFor({ row, channel: "text" }),
    onAutopilot: autopilot,
    onChangeStatus: changeStatus,
    onSaveNotes: saveNotes,
  }

  const isEmpty =
    data.rows.length === 0 && data.failed.length === 0 && data.recentSent.length === 0

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Bot className="w-4 h-4 text-zinc-400" />
          <span className="text-zinc-300">
            {dueCount === 0 ? "Nothing due" : `${dueCount} due now`}
            {data.failed.length > 0 && <span className="text-red-400"> · {data.failed.length} failed</span>}
          </span>
        </div>
        <button
          onClick={() => void fetchData()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors disabled:opacity-60"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      {err && (
        <div className="px-3 py-2 rounded-md bg-red-900/30 border border-red-900/50 text-xs text-red-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1">{err}</div>
          <button onClick={() => setErr(null)} className="text-red-200/70 hover:text-red-100"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {toast && (
        <div className="px-3 py-2 rounded-md bg-emerald-900/30 border border-emerald-900/50 text-xs text-emerald-200">
          {toast}
        </div>
      )}
      {undoBar && (
        <div className="px-3 py-2 rounded-md bg-sky-950/40 border border-sky-900/60 text-xs text-sky-200 flex items-center gap-2">
          <span className="flex-1">{undoBar.text}</span>
          <button
            onClick={() => { const u = undoBar; setUndoBar(null); void u.run() }}
            className="px-2 py-1 rounded border border-sky-800 text-sky-100 hover:bg-sky-900/50 shrink-0"
          >
            Undo
          </button>
        </div>
      )}

      {isEmpty && (
        <div className="text-sm text-zinc-500 py-12 text-center">
          🎉 All caught up — nothing due today.
        </div>
      )}

      {/* Today's work — always expanded. */}
      {buckets.replied.length > 0 && (
        <section>
          <SectionHeader label="Replied" count={buckets.replied.length} tone="ready" />
          <div className="space-y-2">
            {buckets.replied.map(row => (
              <div key={row.clusterKey} className="space-y-1">
                <div className="text-xs text-emerald-300/90 pl-1 truncate">
                  {row.replied?.kind === "missed call" ? "Called you" : row.replied?.kind === "voicemail" ? "Left a voicemail" : row.replied?.kind === "email" ? "Emailed" : "Texted"}
                  {" · "}{new Date(row.replied!.at).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                  {row.replied?.text && row.replied.kind !== "missed call" ? <span className="text-zinc-400"> — “{row.replied.text}”</span> : null}
                </div>
                <ContactCard row={row} {...cardProps} />
              </div>
            ))}
          </div>
        </section>
      )}
      {buckets.ready.length > 0 && (
        <section>
          <SectionHeader label="Ready to send" count={buckets.ready.length} tone="ready" />
          <div className="space-y-2">
            {buckets.ready.map(row => <ContactCard key={row.clusterKey} row={row} {...cardProps} />)}
          </div>
        </section>
      )}
      {buckets.overdue.length > 0 && (
        <section>
          <SectionHeader label="Overdue" count={buckets.overdue.length} tone="overdue" />
          <div className="space-y-2">
            {buckets.overdue.map(row => <ContactCard key={row.clusterKey} row={row} {...cardProps} />)}
          </div>
        </section>
      )}
      {buckets.today.length > 0 && (
        <section>
          <SectionHeader label="Today" count={buckets.today.length} tone="today" />
          <div className="space-y-2">
            {buckets.today.map(row => <ContactCard key={row.clusterKey} row={row} {...cardProps} />)}
          </div>
        </section>
      )}
      {dueCount === 0 && !isEmpty && (
        <div className="text-sm text-zinc-500 py-6 text-center">Nothing due today. Upcoming calls live on each lead card.</div>
      )}

      {/* Everything else — collapsed by default. */}
      {data.failed.length > 0 && (
        <Collapsible
          id="failed" label="Failed" count={data.failed.length} tone="failed"
          open={!!openSections.failed} onToggle={() => setOpenSections(s => ({ ...s, failed: !s.failed }))}
        >
          <div className="space-y-2">
            {data.failed.map(card => (
              <FailedCard
                key={card.id} card={card} acting={actingOn === card.id}
                onRetry={() => void retryFailed(card.id)}
                onDismiss={() => void dismissFailed(card.id)}
                onOpenLead={() => { const k = dripOverlayKey(card); if (k) setLeadOverlay(k) }}
              />
            ))}
          </div>
        </Collapsible>
      )}
      <Collapsible
        id="sent" label={`Recently sent — last ${data.meta.sentHistoryDays}d`} count={data.recentSent.length}
        open={!!openSections.sent} onToggle={() => setOpenSections(s => ({ ...s, sent: !s.sent }))}
      >
        <div className="space-y-1.5">
          {data.recentSent.map(card => (
            <SentRow key={card.id} card={card} onView={() => setSentPopout(card)} />
          ))}
          {data.recentSent.length === 0 && (
            <div className="text-xs text-zinc-600 pl-3">No drips sent in the last {data.meta.sentHistoryDays} days.</div>
          )}
        </div>
      </Collapsible>

      {leadOverlay && <LeadOverlay overlayKey={leadOverlay} onClose={() => setLeadOverlay(null)} />}
      {sentPopout && <SentPopout card={sentPopout} onClose={() => setSentPopout(null)} />}
      {composeFor && (
        <ComposeModal
          row={composeFor.row}
          channel={composeFor.channel}
          onClose={() => setComposeFor(null)}
          onSent={(msg) => { setComposeFor(null); showToast(msg); void fetchData(true) }}
          onOpenLead={() => { const k = leadOverlayKey(composeFor.row); if (k) setLeadOverlay(k) }}
        />
      )}
    </div>
  )
}

// ---- section chrome -------------------------------------------------------

function SectionHeader({ label, count, tone }: { label: string; count: number; tone: "overdue" | "today" | "ready" }) {
  const cls = tone === "overdue" ? "text-red-300" : tone === "ready" ? "text-emerald-300" : "text-amber-300"
  return (
    <div className={`text-sm font-semibold mb-2 ${cls}`}>
      {label} <span className="text-zinc-500 font-normal">· {count}</span>
    </div>
  )
}

function Collapsible({
  id, label, count, tone, open, onToggle, children,
}: {
  id: string
  label: string
  count: number
  tone?: "failed"
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const labelCls = tone === "failed" ? "text-red-400" : "text-zinc-400"
  return (
    <section>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 py-1 text-sm font-semibold hover:text-zinc-200 transition-colors"
      >
        {open ? <ChevronDown className="w-4 h-4 text-zinc-500" /> : <ChevronRight className="w-4 h-4 text-zinc-500" />}
        <span className={labelCls}>{label}</span>
        <span className="text-zinc-600 font-normal">· {count}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  )
}

// ---- the contact card ----------------------------------------------------

interface CardHandlers {
  actingOn: string | null
  editing: Map<string, { message: string; subject: string }>
  intervalOpenFor: string | null
  onCall: Record<string, OnCallPin>
  onEndCall: (row: ContactRow) => void
  onOpenLead: (row: ContactRow) => void
  onSendDrip: (row: ContactRow, queueId: string, opts?: { force?: boolean }) => void
  onRegenerateDrip: (row: ContactRow, queueId: string) => void
  onRedraftDrip: (row: ContactRow, queueId: string, why?: string) => void
  onCoachDrip: (row: ContactRow, queueId: string, args: CoachArgs) => Promise<boolean>
  dripCoachRead: Record<string, string | null>
  onQueueAction: (row: ContactRow, queueId: string, action: "skip" | "snooze", days?: 1 | 3 | 7) => void
  onStartEdit: (queueId: string, t: NextTouch) => void
  onChangeEdit: (queueId: string, field: "message" | "subject", value: string) => void
  onCancelEdit: (queueId: string) => void
  onSaveEdit: (row: ContactRow, queueId: string) => void
  onPrepare: (row: ContactRow) => void
  onSkipForecast: (row: ContactRow) => void
  onPlaceCall: (row: ContactRow) => void
  onSnoozeContact: (row: ContactRow, days: number) => void
  onDoneCall: (row: ContactRow) => void
  onPickInterval: (row: ContactRow, opt: { key: string; label: string; days?: number; months?: number }) => void
  onEmail: (row: ContactRow) => void
  onText: (row: ContactRow) => void
  onAutopilot: (row: ContactRow) => void
  onChangeStatus: (row: ContactRow, choice: { status?: string; flag?: "is_junk" | "is_dnc" }) => void
  onSaveNotes: (row: ContactRow, notes: string) => void
}

// Lifecycle statuses Ryan owns (the AI never writes these). Order matches the
// pipeline progression; "dead" is the only one of these that halts outreach.
const LIFECYCLE_OPTIONS: { key: string; label: string }[] = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "active", label: "Active" },
  { key: "nurture", label: "Nurture" },
  { key: "dead", label: "Dead" },
]
const STATUS_DOT: Record<string, string> = {
  new: "bg-zinc-400", contacted: "bg-blue-400", active: "bg-sky-400",
  nurture: "bg-amber-400", dead: "bg-zinc-600",
}

// Status changer on the worklist card. Lifecycle relabels + the two exit
// flags (junk / DNC). Dismissal follows the iOS-safe pattern (ref + document
// pointerdown added on a setTimeout(0), NOT a full-screen overlay) so an
// outside tap closes it without a fixed inset-0 layer eating scroll/taps.
function StatusMenu({
  status,
  disabled,
  onPick,
}: {
  status: string
  disabled: boolean
  onPick: (choice: { status?: string; flag?: "is_junk" | "is_dnc" }) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    let cleanup = () => {}
    // setTimeout(0): let the click that opened the menu finish before we start
    // listening, otherwise that same click closes it immediately.
    const t = setTimeout(() => {
      const onDown = (e: PointerEvent) => {
        if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
      }
      document.addEventListener("pointerdown", onDown)
      cleanup = () => document.removeEventListener("pointerdown", onDown)
    }, 0)
    return () => { clearTimeout(t); cleanup() }
  }, [open])

  const pick = (choice: { status?: string; flag?: "is_junk" | "is_dnc" }) => {
    setOpen(false)
    onPick(choice)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Change lead status"
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 transition-colors disabled:opacity-60"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status] ?? "bg-zinc-400"}`} />
        <span className="capitalize">{status}</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-48 rounded-md border border-zinc-700 bg-zinc-900 shadow-xl py-1 text-xs">
          {LIFECYCLE_OPTIONS.map(o => (
            <button
              key={o.key}
              type="button"
              onClick={() => pick({ status: o.key })}
              className={`w-full flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800 text-left ${o.key === status ? "text-zinc-100" : "text-zinc-300"}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[o.key]}`} />
              {o.label}
              {o.key === status && <Check className="w-3 h-3 ml-auto text-emerald-400" />}
            </button>
          ))}
          <div className="my-1 border-t border-zinc-800" />
          <button
            type="button"
            onClick={() => pick({ flag: "is_junk" })}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800 text-left text-amber-300/90"
          >
            <Ban className="w-3 h-3" /> Mark junk
          </button>
          <button
            type="button"
            onClick={() => pick({ flag: "is_dnc" })}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800 text-left text-red-300/90"
          >
            <ShieldOff className="w-3 h-3" /> Mark Do-Not-Contact
          </button>
        </div>
      )}
    </div>
  )
}

// "Where it stands" context, shown under the card header so Ryan doesn't have
// to expand the full lead card to remember where a relationship left off. The
// AI summary (auto, reflects the latest call) is clamped to 2 lines and
// expands on tap; the note below it is inline-editable so he can jot an update
// after a call without leaving the queue.
function ContextBlock({
  aiSummary,
  notes,
  history,
  onSaveNotes,
}: {
  aiSummary: string | null
  notes: string | null
  // Recent history, rendered between the summary and the note.
  history?: ReactNode
  onSaveNotes: (value: string) => void
}) {
  // The card shows and edits only Ryan's own text; a skip-trace block in the
  // same column stays put (full lead card only) and is re-attached on save.
  const { mine, skipTrace } = splitLeadNotes(notes)
  const [expanded, setExpanded] = useState(false)
  const [editingNotes, setEditingNotes] = useState(false)
  const [draft, setDraft] = useState(mine)
  // Re-sync from props only while not editing, so a 30s background refetch
  // can't wipe an in-progress note (same guard as the lead-card field editor).
  useEffect(() => { if (!editingNotes) setDraft(mine) }, [mine, editingNotes])

  const commitNotes = () => {
    setEditingNotes(false)
    const t = draft.trim()
    if (t !== mine) onSaveNotes(joinLeadNotes(t, skipTrace) ?? "")
  }

  // Nothing to show and nothing being added → just the faint "Add note" link.
  return (
    <div className="px-3 pb-2 space-y-1.5">
      {aiSummary && (
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          title={expanded ? "Collapse" : "Expand"}
          className="w-full text-left text-xs text-zinc-400 hover:text-zinc-300 flex gap-1.5"
        >
          <span className="text-zinc-500 shrink-0">🤖</span>
          <span className={expanded ? "" : "line-clamp-2"}>{aiSummary}</span>
        </button>
      )}
      {history}
      {editingNotes ? (
        <textarea
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commitNotes}
          onKeyDown={e => {
            if (e.key === "Escape") { setDraft(mine); setEditingNotes(false) }
          }}
          rows={2}
          placeholder="Where did this leave off? Add a note…"
          className="w-full text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-y"
          style={{ fontSize: 16 }}
        />
      ) : mine ? (
        <button
          type="button"
          onClick={() => setEditingNotes(true)}
          className="group w-full text-left text-xs text-zinc-300 bg-zinc-900/60 rounded px-2 py-1.5 hover:bg-zinc-900 flex gap-1.5"
        >
          <span className="text-zinc-500 shrink-0">📝</span>
          <span className="flex-1 whitespace-pre-wrap break-words">{mine}</span>
          <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-60 shrink-0 mt-0.5" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setEditingNotes(true)}
          className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          <Pencil className="w-3 h-3" /> Add note
        </button>
      )}
    </div>
  )
}

// ---- Recent history ---------------------------------------------------------
// Ryan 2026-10-26: "see very clearly what's been said." The last few calls /
// voicemails / texts / emails, one line each, newest first. Texts show as
// written; long calls show a one-line summary. ▸ opens the full text and
// "Show all" the whole history — both fetched on tap from
// /api/follow-ups/history so transcripts stay out of the 30s refetch.

const HISTORY_ICON: Record<HistoryItem["kind"], string> = {
  call: "📞", voicemail: "🎙️", text: "💬", email: "✉️", form: "📝",
}

function historyFirstName(name: string | null): string {
  const n = (name || "").trim()
  if (!n || /^[+\d(]/.test(n) || /^(unknown|anonymous)/i.test(n)) return "They"
  return n.split(/\s+/)[0]
}

function historyWho(it: HistoryItem, first: string): string {
  if (it.dir === "out") {
    if (it.auto) return it.kind === "email" ? "Auto-email" : "Auto-text"
    return it.kind === "text" ? "You texted" : it.kind === "email" ? "You emailed" : "You called"
  }
  switch (it.kind) {
    case "voicemail": return `${first} left a voicemail`
    case "call": return `${first} called`
    case "text": return `${first} texted`
    case "email": return `${first} emailed`
    default: return `${first} sent the web form`
  }
}

function historyDate(iso: string): string {
  // Year always, even this year's (Ryan 2026-10-30).
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// One-liners for long transcripts are written server-side the first time a
// card shows them. Cards queue their ids here; one request at a time, 8 ids
// each, so a page of cards doesn't fan out into dozens of parallel model
// calls. A failed id resolves null and is retried on the next page load.
const pendingLineIds: string[] = []
const lineWaiters = new Map<string, ((line: string | null) => void)[]>()
let lineQueueRunning = false

function requestHistoryLine(id: string): Promise<string | null> {
  return new Promise(resolve => {
    const waiting = lineWaiters.get(id)
    if (waiting) { waiting.push(resolve); return }
    lineWaiters.set(id, [resolve])
    pendingLineIds.push(id)
    void drainLineQueue()
  })
}

async function drainLineQueue() {
  if (lineQueueRunning) return
  lineQueueRunning = true
  try {
    while (pendingLineIds.length > 0) {
      const batch = pendingLineIds.splice(0, 8)
      let lines: Record<string, string> = {}
      try {
        const res = await fetch("/api/follow-ups/history-lines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: batch }),
        })
        if (res.ok) lines = ((await res.json()) as { lines?: Record<string, string> }).lines ?? {}
      } catch { /* resolves null below */ }
      for (const id of batch) {
        const line = lines[id] ?? null
        lineWaiters.get(id)?.forEach(w => w(line))
        lineWaiters.delete(id)
      }
    }
  } finally {
    lineQueueRunning = false
  }
}

function HistoryBlock({ row }: { row: ContactRow }) {
  const preview = row.history
  const [full, setFull] = useState<HistoryItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [lines, setLines] = useState<Record<string, string>>({})
  const first = historyFirstName(row.name)

  // A new touch on the contact → the cached full history is stale.
  const head = preview?.items[0]?.id ?? ""
  const total = preview?.total ?? 0
  useEffect(() => { setFull(null) }, [head, total])

  const items = showAll && full ? full : preview?.items ?? []

  // Ask for the one-liners this card is missing (long transcripts).
  const needIds = items.filter(i => i.needsLine && !lines[i.id]).map(i => i.id).join(",")
  useEffect(() => {
    if (!needIds) return
    let alive = true
    for (const id of needIds.split(",")) {
      void requestHistoryLine(id).then(line => {
        if (alive && line) setLines(prev => ({ ...prev, [id]: line }))
      })
    }
    return () => { alive = false }
  }, [needIds])

  async function loadFull(): Promise<void> {
    if (full || loading) return
    setLoading(true)
    setLoadFailed(false)
    try {
      const res = await fetch(`/api/follow-ups/history?key=${encodeURIComponent(row.clusterKey)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { items?: HistoryItem[] }
      setFull(data.items ?? [])
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }

  function toggleItem(id: string) {
    void loadFull()
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (!preview || preview.total === 0) return null
  const fullById = new Map((full ?? []).map(i => [i.id, i]))

  return (
    <div className="text-xs space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">Recent history</div>
      <ul className="space-y-1">
        {items.map(it => {
          const isOpen = open.has(it.id)
          const fullText = fullById.get(it.id)?.full
          return (
            <li key={it.id}>
              <button
                type="button"
                disabled={!it.more}
                onClick={() => toggleItem(it.id)}
                title={it.more ? (isOpen ? "Hide full text" : "Show full text") : undefined}
                className="w-full text-left flex gap-1.5 text-zinc-300 enabled:hover:text-zinc-100"
              >
                <span className="shrink-0">{HISTORY_ICON[it.kind]}</span>
                <span className="flex-1 min-w-0 break-words">
                  <span className="text-zinc-500">{historyDate(it.at)} · {historyWho(it, first)} — </span>
                  {lines[it.id] ?? it.line}
                </span>
                {it.more && (
                  <ChevronRight className={`w-3.5 h-3.5 shrink-0 mt-0.5 text-zinc-500 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                )}
              </button>
              {isOpen && (
                <div className="mt-1 ml-5 px-2 py-1.5 rounded bg-zinc-900/60 text-zinc-400 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                  {fullText ?? (loadFailed ? "Couldn't load the full text — tap again." : "Loading…")}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {preview.total > preview.items.length && (
        <button
          type="button"
          onClick={() => { if (!showAll) void loadFull(); setShowAll(s => !s) }}
          className="text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          {showAll ? "Show less" : loading ? "Loading…" : `Show all (${preview.total})`}
        </button>
      )}
    </div>
  )
}

const STAGE_CHIP: Record<string, string> = { closed: "🏁 Closed", pending: "📝 Pending", offer: "💰 Offer", appointment: "📅 Appt", lead: "🎯 Lead" }

function ContactCard({ row, ...h }: { row: ContactRow } & CardHandlers) {
  const acting = h.actingOn === row.clusterKey
  const callTouch =
    row.primary.kind === "call" ? row.primary : row.secondary?.kind === "call" ? row.secondary : null
  const dripTouch =
    row.primary.kind === "drip" ? row.primary : row.secondary?.kind === "drip" ? row.secondary : null
  const overdue = classifyUrgency(row.primary) === "overdue"
  const temp = row.temperature ? TEMP_BADGE[row.temperature] : null
  const pin = h.onCall[row.clusterKey]
  const callingStrip = pin && row.phone ? <CallingFromStrip from={pin.from} onEnd={() => h.onEndCall(row)} /> : null
  // Sales Coach script (CallScriptPanel): opens on its own when a call is
  // placed (the card is pinned), or on the Script button before dialing.
  const [scriptOpen, setScriptOpen] = useState(false)
  useEffect(() => { if (pin) setScriptOpen(true) }, [pin])
  const scriptPanel = row.phone && scriptOpen
    ? <CallScriptPanel phone={row.phone} leadId={pin?.leadId ?? null} callerId={pin?.from ?? null} onClose={() => setScriptOpen(false)} />
    : null

  return (
    <div className={`rounded-md border overflow-hidden ${pin ? "border-emerald-700/70 bg-emerald-950/10" : overdue ? "border-red-900/50 bg-red-950/20" : "border-zinc-800 bg-zinc-950"}`}>
      {/* header */}
      <div className="px-3 py-2 flex items-center gap-2 text-xs flex-wrap">
        {temp && <span className={temp.cls} title={row.temperature ?? ""}>{temp.emoji}</span>}
        {row.stage && STAGE_CHIP[row.stage] && (
          <span className="px-1.5 py-0.5 text-[10px] rounded border border-zinc-700 bg-zinc-900 text-zinc-300" title="Furthest stage reached">
            {STAGE_CHIP[row.stage]}
          </span>
        )}
        <button
          type="button"
          onClick={() => h.onOpenLead(row)}
          disabled={!row.phone && !row.email}
          className="text-zinc-100 font-medium text-sm hover:text-emerald-400 hover:underline disabled:no-underline disabled:hover:text-zinc-100 underline-offset-2 text-left"
        >
          {row.name || (row.phone && formatPhone(row.phone)) || row.email || "(unknown)"}
        </button>
        {row.name && (row.phone || row.email) && (
          <span className="text-zinc-500">{row.phone ? formatPhone(row.phone) : row.email}</span>
        )}
        {row.source && <><span className="text-zinc-600">·</span><span className="text-zinc-500">{row.source}</span></>}
        {row.propertyAddress && (
          <span className="text-zinc-500 truncate max-w-[200px]" title={row.propertyAddress}>🏠 {row.propertyAddress}</span>
        )}
        {isOnMarket(row.listing) && (
          <span
            className="px-1.5 py-0.5 text-[9px] font-semibold rounded uppercase tracking-wider bg-rose-950 text-rose-300 border border-rose-900 shrink-0"
            title={`Listed on the MLS${row.listing!.mls ? ` (${row.listing!.mls})` : ""} — call last`}
          >
            🏷 {listingChipLabel(row.listing!)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <StatusMenu
            status={row.status}
            disabled={acting}
            onPick={(choice) => h.onChangeStatus(row, choice)}
          />
          {row.phone && (
            <button
              onClick={() => h.onAutopilot(row)}
              disabled={acting}
              title="Fixed check-in texts (now, +30 days, then every 90) — off this list until they reply"
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-sky-900/60 text-sky-300/90 hover:text-sky-100 hover:bg-sky-950/50 transition-colors disabled:opacity-60 shrink-0"
            >
              <Bot className="w-3.5 h-3.5" /> Autopilot
            </button>
          )}
        </div>
      </div>

      {/* context — where the relationship stands, what's been said, and
          the inline-editable note */}
      <ContextBlock
        aiSummary={row.aiSummary}
        notes={row.notes}
        history={<HistoryBlock row={row} />}
        onSaveNotes={(v) => h.onSaveNotes(row, v)}
      />

      {/* call block */}
      {callTouch && (
        <CallBlock
          row={row} touch={callTouch} acting={acting}
          intervalOpen={h.intervalOpenFor === row.clusterKey}
          onCall={() => h.onPlaceCall(row)}
          onScript={() => setScriptOpen(v => !v)}
          onDone={() => h.onDoneCall(row)}
          onPickInterval={(opt) => h.onPickInterval(row, opt)}
          onEmail={() => h.onEmail(row)}
          onText={() => h.onText(row)}
        />
      )}
      {callTouch && callingStrip}

      {/* drip block */}
      {dripTouch && (
        <DripBlock
          row={row} touch={dripTouch} acting={acting} hasCallAbove={!!callTouch}
          editDraft={dripTouch.queueId ? h.editing.get(dripTouch.queueId) ?? null : null}
          onOpenLead={() => h.onOpenLead(row)}
          onCall={() => h.onPlaceCall(row)}
          onSend={(opts) => dripTouch.queueId && h.onSendDrip(row, dripTouch.queueId, opts)}
          onRedraft={(why) => dripTouch.queueId && h.onRedraftDrip(row, dripTouch.queueId, why)}
          onCoach={(args) => dripTouch.queueId ? h.onCoachDrip(row, dripTouch.queueId, args) : Promise.resolve(false)}
          coachRead={dripTouch.queueId ? h.dripCoachRead[dripTouch.queueId] ?? null : null}
          onSkip={() => dripTouch.queueId && h.onQueueAction(row, dripTouch.queueId, "skip")}
          onStartEdit={() => dripTouch.queueId && h.onStartEdit(dripTouch.queueId, dripTouch)}
          onChangeEdit={(f, v) => dripTouch.queueId && h.onChangeEdit(dripTouch.queueId, f, v)}
          onCancelEdit={() => dripTouch.queueId && h.onCancelEdit(dripTouch.queueId)}
          onSaveEdit={() => dripTouch.queueId && h.onSaveEdit(row, dripTouch.queueId)}
          onPrepare={() => h.onPrepare(row)}
          onSkipForecast={() => h.onSkipForecast(row)}
        />
      )}
      {!callTouch && callingStrip}
      {scriptPanel}
    </div>
  )
}

// Shown under the Call button while a call is live: the number the lead
// sees (so Ryan can leave it on a voicemail) and End call to unpin the card.
function CallingFromStrip({ from, onEnd }: { from: string | null; onEnd: () => void }) {
  return (
    <div className="px-3 py-2 border-t border-emerald-900/60 bg-emerald-950/30 flex items-center gap-2 flex-wrap">
      <PhoneOutgoing className="w-4 h-4 text-emerald-400 shrink-0" />
      <span className="text-sm font-semibold text-emerald-300">
        {from ? `Calling from ${formatPhone(from) ?? from}` : "Calling — ringing your cell"}
      </span>
      <button
        onClick={onEnd}
        className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded bg-zinc-900 border border-zinc-700 hover:border-zinc-500 text-zinc-200 text-xs font-medium transition-colors"
      >
        <PhoneOff className="w-3.5 h-3.5" /> End call
      </button>
    </div>
  )
}

function ChannelIcon({ channel }: { channel: string }) {
  return channel === "email"
    ? <Mail className="w-3.5 h-3.5 text-zinc-400" />
    : <MessageSquare className="w-3.5 h-3.5 text-zinc-400" />
}

// ---- call block ----------------------------------------------------------

function CallBlock({
  row, touch, acting, intervalOpen, onCall, onScript, onDone, onPickInterval, onEmail, onText,
}: {
  row: ContactRow
  touch: NextTouch
  acting: boolean
  intervalOpen: boolean
  onCall: () => void
  onScript: () => void
  onDone: () => void
  onPickInterval: (opt: { key: string; label: string; days?: number; months?: number }) => void
  onEmail: () => void
  onText: () => void
}) {
  const overdue = classifyUrgency(touch) === "overdue"
  // resolveCallTouch marks a follow-up on a phone-less lead as channel="email".
  // The Call button below was already gated on row.phone, but the heading still
  // read "Follow-up call" — so an email-only lead like Grace Chang showed
  // "Follow-up call · today" for someone we have no number for (2026-09-03).
  const byEmail = touch.channel === "email"
  const HeadIcon = byEmail ? Mail : Phone
  return (
    <div className="px-3 py-2 border-t border-zinc-900">
      <div className="flex items-center gap-1.5 text-xs">
        <HeadIcon className="w-3.5 h-3.5 text-emerald-400" />
        <span className="text-zinc-300 font-medium">{byEmail ? "Follow-up email" : "Follow-up call"}</span>
        <span className="text-zinc-600">·</span>
        <span className={overdue ? "text-red-300" : "text-amber-300"}>{describeTouchWhen(touch)}</span>
        {isOwedReason(touch.reason) && (
          <span
            className="px-1.5 py-0.5 text-[9px] font-semibold rounded uppercase tracking-wider bg-amber-950 text-amber-300 border border-amber-900 shrink-0"
            title="Ryan promised this seller a deliverable — due the next day"
          >
            Owed
          </span>
        )}
      </div>
      {touch.reason && <div className="mt-1 text-xs text-zinc-400 italic">{stripOwedPrefix(touch.reason)}</div>}
      <div className="mt-2 flex items-center gap-1.5 flex-wrap justify-end">
        {row.phone && (
          <button
            onClick={onScript}
            title="Read the voicemail + live script before dialing"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-zinc-900 border border-zinc-700 hover:border-zinc-500 text-zinc-200 text-xs font-medium transition-colors"
          >
            <FileText className="w-3.5 h-3.5" /> Script
          </button>
        )}
        {row.phone && (
          <button
            onClick={onCall}
            disabled={acting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 text-white text-xs font-medium transition-colors"
          >
            {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PhoneOutgoing className="w-3.5 h-3.5" />}
            Call
          </button>
        )}
        {/* Email is always offered — even when no address is on file yet, the
            compose modal lets Ryan type one (and persists it to the lead).
            Previously this was gated on `row.email`, so phone-only leads (most
            inbound SMS/call leads) showed Call + Text but never Email. */}
        <button
          onClick={onEmail}
          disabled={acting}
          title={row.email ? `Email ${row.email}` : "Email — no address on file yet; you can add one"}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-emerald-900/30 border border-emerald-800/60 text-emerald-200 hover:bg-emerald-900/50 text-xs font-medium transition-colors disabled:opacity-60"
        >
          <Mail className="w-3.5 h-3.5" /> Email
        </button>
        {row.phone && (
          <button
            onClick={onText}
            disabled={acting}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-emerald-900/30 border border-emerald-800/60 text-emerald-200 hover:bg-emerald-900/50 text-xs font-medium transition-colors disabled:opacity-60"
          >
            <MessageSquare className="w-3.5 h-3.5" /> Text
          </button>
        )}
        <button
          onClick={onDone}
          disabled={acting}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 text-xs font-medium transition-colors disabled:opacity-60"
        >
          {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          Done
        </button>
      </div>
      {intervalOpen && (
        <div className="mt-2 pt-2 border-t border-zinc-800">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Set next follow-up</div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {INTERVAL_OPTIONS.map(opt => (
              <button
                key={opt.key}
                onClick={() => onPickInterval(opt)}
                disabled={acting}
                className={`inline-flex items-center px-3 py-1.5 min-h-[32px] rounded-full text-xs font-medium transition-colors disabled:opacity-50 ${
                  opt.key === "none"
                    ? "bg-zinc-900 border border-zinc-800 text-zinc-400 hover:border-zinc-700"
                    : "bg-emerald-900/40 border border-emerald-900/60 text-emerald-200 hover:bg-emerald-900/60"
                }`}
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

// ---- drip block ----------------------------------------------------------

function DripBlock({
  row, touch, acting, hasCallAbove, editDraft,
  onOpenLead, onCall, onSend, onRedraft, onCoach, coachRead, onSkip,
  onStartEdit, onChangeEdit, onCancelEdit, onSaveEdit,
  onPrepare, onSkipForecast,
}: {
  row: ContactRow
  touch: NextTouch
  acting: boolean
  hasCallAbove: boolean
  editDraft: { message: string; subject: string } | null
  onOpenLead: () => void
  onCall: () => void
  onSend: (opts?: { force?: boolean }) => void
  onRedraft: (why?: string) => void
  onCoach: (args: CoachArgs) => Promise<boolean>
  coachRead: string | null
  onSkip: () => void
  onStartEdit: () => void
  onChangeEdit: (field: "message" | "subject", value: string) => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onPrepare: () => void
  onSkipForecast: () => void
}) {
  const isEditing = editDraft != null
  const channelLabel = touch.channel === "email" ? "Email" : "iMessage"
  const dueNow = !touch.isQueued && new Date(touch.due).getTime() <= Date.now()
  // Stale = the draft pre-dates a non-drip event on the cluster. Surfaces
  // a warning + Regenerate/Send-anyway in place of plain Send so Ryan can
  // pick consciously instead of having the send route silent-skip the row.
  const stale = touch.isQueued && touch.stale === true

  return (
    <div className={`px-3 py-2 ${hasCallAbove ? "border-t border-zinc-900" : "border-t border-zinc-900"}`}>
      <div className="flex items-center gap-1.5 text-xs">
        <ChannelIcon channel={touch.channel ?? "imessage"} />
        <span className="text-zinc-300 font-medium">
          Drip #{touch.touchNumber} {channelLabel}
        </span>
        <span className="text-zinc-600">·</span>
        <span className={touch.isQueued ? "text-amber-300" : "text-zinc-500"}>
          {describeTouchWhen(touch)}
        </span>
        {stale && (
          <>
            <span className="text-zinc-600">·</span>
            <span className="inline-flex items-center gap-1 text-amber-400" title="A non-drip event landed on this cluster after this draft was written — Send will be auto-skipped. Send anyway to override, or Skip.">
              <AlertTriangle className="w-3 h-3" /> stale
            </span>
          </>
        )}
      </div>
      {stale && !isEditing && (
        <div className="mt-1 text-xs text-amber-400/80">
          Contact had activity since this draft was written.
        </div>
      )}

      {/* queued drip — Not right / Redraft through the shared reply engine */}
      {touch.isQueued && !isEditing && (
        <div className="mt-1.5">
          <ReplyPlanner
            kind="lead"
            hideChips
            plan={{ moment: "silence_breaker", temperature: row.temperature, next_action: "drip", reason: "", source: "ai" }}
            busy={acting}
            error={null}
            status={null}
            onPlanChange={() => {}}
            onRegenerate={(why) => onRedraft(why)}
            coach={{ read: coachRead, currentBody: touch.message ?? "", onDraft: onCoach }}
          />
        </div>
      )}

      {/* queued drip — show + edit the generated message */}
      {touch.isQueued && !isEditing && (
        <div className="mt-1.5 text-sm text-zinc-200 bg-zinc-900/60 whitespace-pre-wrap break-words rounded px-3 py-2">
          {touch.subject && <div className="text-xs text-zinc-500 mb-1">Subject: <span className="text-zinc-300">{touch.subject}</span></div>}
          {touch.message || <span className="text-zinc-500">(no message)</span>}
        </div>
      )}
      {touch.isQueued && isEditing && (
        <div className="mt-1.5 space-y-2">
          {(touch.channel === "email" || touch.subject) && (
            <input
              value={editDraft!.subject}
              onChange={e => onChangeEdit("subject", e.target.value)}
              placeholder="Subject"
              className="w-full text-sm bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-zinc-700"
            />
          )}
          <textarea
            value={editDraft!.message}
            onChange={e => onChangeEdit("message", e.target.value)}
            rows={Math.max(4, Math.min(12, editDraft!.message.split("\n").length + 1))}
            className="w-full text-sm bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-zinc-700 resize-y"
          />
        </div>
      )}

      {/* forecast drip — not generated yet */}
      {!touch.isQueued && (
        <div className="mt-1 text-xs text-zinc-500">
          {dueNow ? "Due — generate the draft to review it." : "The engine drafts this automatically when it comes due."}
        </div>
      )}

      {/* actions */}
      <div className="mt-2 flex items-center gap-1.5 flex-wrap justify-end">
        {/* A drip-only card (no follow-up call scheduled) had no way to
            call — Ryan couldn't ring a historic seller straight from the
            card (2026-11-02). When a CallBlock sits above, its Call covers it. */}
        {row.phone && !hasCallAbove && !isEditing && (
          <button
            onClick={onCall}
            disabled={acting}
            title={`Call ${formatPhone(row.phone) ?? row.phone}`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-emerald-900/30 border border-emerald-800/60 text-emerald-200 hover:bg-emerald-900/50 text-xs font-medium transition-colors disabled:opacity-60"
          >
            <PhoneOutgoing className="w-3.5 h-3.5" /> Call
          </button>
        )}
        {touch.isQueued && !isEditing && (
          <>
            <button
              onClick={onStartEdit}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors disabled:opacity-60"
            >
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
            <button
              onClick={onSkip}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 text-xs font-medium transition-colors disabled:opacity-60"
            >
              <X className="w-3.5 h-3.5" /> Skip
            </button>
            <button
              onClick={() => onSend(stale ? { force: true } : undefined)}
              disabled={acting}
              title={stale ? "Override the staleness check and send this draft as-is." : undefined}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded text-white text-xs font-medium transition-colors disabled:bg-zinc-800 disabled:text-zinc-600 ${stale ? "bg-amber-600 hover:bg-amber-500" : "bg-emerald-600 hover:bg-emerald-500"}`}
            >
              {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              {stale ? "Send anyway" : "Send"}
            </button>
          </>
        )}
        {touch.isQueued && isEditing && (
          <>
            <button
              onClick={onCancelEdit}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 text-xs font-medium transition-colors disabled:opacity-60"
            >
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
            <button
              onClick={onSaveEdit}
              disabled={acting || editDraft!.message.trim().length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
            >
              {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Save edit
            </button>
          </>
        )}
        {!touch.isQueued && (
          <>
            <button
              onClick={onSkipForecast}
              disabled={acting}
              title="Advance the drip counter without sending"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 text-xs font-medium transition-colors disabled:opacity-60"
            >
              <SkipForward className="w-3.5 h-3.5" /> Skip
            </button>
            {dueNow && (
              <button
                onClick={onPrepare}
                disabled={acting}
                title="Generate the draft now so you can review and send it"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded bg-sky-900/40 border border-sky-900/60 text-sky-200 hover:bg-sky-900/60 text-xs font-medium transition-colors disabled:opacity-60"
              >
                {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Prepare
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ---- collapsed-section cards ---------------------------------------------

function FailedCard({
  card, acting, onRetry, onDismiss, onOpenLead,
}: {
  card: DripCard
  acting: boolean
  onRetry: () => void
  onDismiss: () => void
  onOpenLead: () => void
}) {
  return (
    <div className="rounded-md border border-red-900/50 bg-red-950/20 overflow-hidden">
      <div className="px-3 py-2 border-b border-zinc-900 flex items-center gap-2 text-xs flex-wrap">
        <ChannelIcon channel={card.channel} />
        <button
          type="button"
          onClick={onOpenLead}
          disabled={!card.caller_phone && !card.email}
          className="text-zinc-200 font-medium hover:text-emerald-400 hover:underline disabled:no-underline underline-offset-2 text-left"
        >
          {card.name || formatPhone(card.caller_phone) || card.email || "(unknown)"}
        </button>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">#{card.touch_number} {card.channel === "email" ? "Email" : "iMessage"}</span>
        <span className="text-zinc-600">·</span>
        <span className="text-red-300">failed {relativeFromNow(card.created_at)}</span>
      </div>
      <div className="px-3 pt-2 text-xs text-red-300 flex items-start gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span className="break-words">{card.error || "Unknown error"}</span>
      </div>
      <div className="px-3 py-2 text-sm text-zinc-300 bg-zinc-900/60 whitespace-pre-wrap break-words mx-3 my-2 rounded">
        {card.message}
      </div>
      <div className="px-3 py-2 border-t border-zinc-900 flex items-center justify-end gap-2">
        <button
          onClick={onDismiss}
          disabled={acting}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 text-xs font-medium transition-colors disabled:opacity-60"
        >
          {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
          Dismiss
        </button>
        <button
          onClick={onRetry}
          disabled={acting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 text-white text-xs font-medium transition-colors"
        >
          {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Retry
        </button>
      </div>
    </div>
  )
}

function SentRow({ card, onView }: { card: DripCard; onView: () => void }) {
  return (
    <div className="px-3 py-2 rounded-md border border-zinc-900 bg-zinc-950/60 flex items-center gap-2 text-xs">
      <ChannelIcon channel={card.channel} />
      <span className="text-zinc-300 font-medium">{card.name || formatPhone(card.caller_phone) || card.email || "(unknown)"}</span>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-500">#{card.touch_number} {card.channel === "email" ? "Email" : "iMessage"}</span>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-500 inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {relativeFromNow(card.sent_at || card.created_at)}</span>
      <button
        onClick={onView}
        className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 transition-colors"
      >
        <Eye className="w-3.5 h-3.5" /> View
      </button>
    </div>
  )
}

function SentPopout({ card, onClose }: { card: DripCard; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="relative w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <ChannelIcon channel={card.channel} />
          <span className="text-zinc-100 font-medium">{card.name || formatPhone(card.caller_phone) || card.email || "(unknown)"}</span>
          <span className="text-zinc-600">·</span>
          <span className="text-xs text-zinc-400">#{card.touch_number} {card.channel === "email" ? "Email" : "iMessage"}</span>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div className="text-xs text-zinc-500">
            Sent <span className="text-zinc-300">{relativeFromNow(card.sent_at || card.created_at)}</span>
          </div>
          {card.subject && (
            <div className="text-sm">
              <div className="text-xs text-zinc-500 mb-1">Subject</div>
              <div className="text-zinc-200">{card.subject}</div>
            </div>
          )}
          <div className="text-sm">
            <div className="text-xs text-zinc-500 mb-1">Message</div>
            <div className="text-zinc-200 whitespace-pre-wrap break-words bg-zinc-900/60 rounded px-3 py-2">{card.message}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Manual-outreach compose popup. The follow-up reminder says "reach out" —
// this lets Ryan pick the channel (Email or Text) and send his own message,
// independent of the drip cadence. AI Draft pulls the same context-aware
// draft the lead card uses (/api/leads/[id]/draft-message, which reads the
// conversation history + notes). A manual send naturally pauses the drip
// via the engine's existing HOLD logic.
function ComposeModal({
  row, channel, onClose, onSent, onOpenLead,
}: {
  row: ContactRow
  channel: "email" | "text"
  onClose: () => void
  onSent: (msg: string) => void
  onOpenLead: () => void
}) {
  const isEmail = channel === "email"
  // An inbound email row exists → thread the reply instead of a fresh email.
  const threaded = isEmail && !!row.emailReplyLeadId
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  // Recipient address. Prefilled from the lead when known; editable, and the
  // only way to email a phone-only lead that has no address on file yet.
  const [to, setTo] = useState(row.email ?? "")
  const needsRecipient = isEmail && !threaded && !row.email
  const [drafting, setDrafting] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Reply Planner: plan chips + the draft they produced.
  const [plan, setPlan] = useState<Plan | null>(null)
  const [draftId, setDraftId] = useState<string | null>(null)
  const [planStatus, setPlanStatus] = useState<string | null>(null)
  const [coachRead, setCoachRead] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  // Coach mode: Ryan's gist → Opus reads the whole history → read + draft.
  async function coach(args: CoachArgs): Promise<boolean> {
    setDrafting(true)
    setError(null)
    try {
      const data = await requestCoach({
        leadId: row.leadId,
        channel: isEmail ? "email" : "sms",
        surface: "followups",
        gist: args.gist,
        turns: args.turns,
        plan: args.plan ?? plan,
        parentDraftId: args.turns.length ? draftId : null,
      })
      setPlan(data.plan)
      setDraftId(data.draftId)
      setCoachRead(data.read || null)
      setPlanStatus(data.critic && !data.critic.ok && data.critic.issues.length ? `check: ${data.critic.issues.join("; ")}` : args.turns.length ? "refined" : "coached")
      setBody(data.body || "")
      if (isEmail && data.subject && !threaded) setSubject(data.subject)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setDrafting(false)
    }
  }

  const aiDraft = useCallback(async (opts?: { why?: string; plan?: Plan | null }) => {
    setDrafting(true)
    setError(null)
    try {
      const data = await requestDraft({
        leadId: row.leadId,
        channel: isEmail ? "email" : "sms",
        surface: "followups",
        plan: opts?.plan !== undefined ? opts.plan : plan,
        why: opts?.why ?? null,
        parentDraftId: opts?.why ? draftId : null,
        previousDraft: opts?.why && body.trim() ? { subject: subject || null, body } : null,
      })
      setPlan(data.plan)
      setDraftId(data.draftId)
      setPlanStatus(data.critic && !data.critic.ok && data.critic.issues.length ? `check: ${data.critic.issues.join("; ")}` : opts?.why ? "redrafted from your note" : null)
      setBody(data.body || "")
      if (isEmail && data.subject && !threaded) setSubject(data.subject)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDrafting(false)
    }
  }, [row.leadId, isEmail, threaded, plan, draftId, body, subject])

  // The modal exists to write this reply: plan + draft as soon as it opens.
  const openedRef = useRef(false)
  useEffect(() => {
    if (openedRef.current) return
    openedRef.current = true
    void aiDraft()
  }, [aiDraft])

  async function send() {
    const text = body.trim()
    if (!text) return
    if (isEmail && !threaded && !subject.trim()) {
      setError("Subject is required for a new email.")
      return
    }
    const recipient = to.trim()
    if (needsRecipient && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
      setError("Enter a valid recipient email address.")
      return
    }
    setSending(true)
    setError(null)
    try {
      let res: Response
      if (!isEmail) {
        res = await fetch("/api/leads/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: row.phone, message: text, source: row.source, draftId: draftId ?? undefined }),
        })
      } else if (threaded) {
        res = await fetch("/api/leads/email-reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId: row.emailReplyLeadId, message: text, draftId: draftId ?? undefined }),
        })
      } else {
        res = await fetch(`/api/leads/${row.leadId}/send-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // `to` is sent only when the lead has no stored address — the route
          // uses it as the recipient and saves it back to the lead so future
          // touches know it. When the lead already has an email, omit it and
          // let the route resolve it server-side (handles cluster siblings).
          body: JSON.stringify({ subject: subject.trim(), body: text, draftId: draftId ?? undefined, ...(needsRecipient ? { to: recipient } : {}) }),
        })
      }
      const data = await res.json().catch(() => ({}))
      // /send returns {success}; /email-reply + /send-email return {ok}.
      if (!res.ok || !(data.success || data.ok)) throw new Error(data.error || `HTTP ${res.status}`)
      // The send routes (/api/leads/send, /send-email, /email-reply) each call
      // registerManualTouch server-side, which now owns BOTH sides of "this
      // outreach is the touch": it resets the drip cadence AND consumes any
      // due/overdue follow-up reminder for the cluster (clear when a drip
      // campaign carries the next touch, else roll ~1wk). So there's no extra
      // PATCH here — the old one double-advanced the drip counter and only
      // handled follow-ups on this one UI path.
      // Send executes the plan (nurture / drip / call reminder / close).
      let planNote: string | null = null
      try {
        planNote = await executePlan(row.leadId, plan)
      } catch (e) {
        console.error("executePlan failed:", e)
      }
      onSent(`${isEmail ? "Email sent" : "Text sent"}${planNote ? ` · ${planNote}` : ""}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSending(false)
    }
  }

  const who = row.name || (row.phone && formatPhone(row.phone)) || row.email || "(unknown)"
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          {isEmail
            ? <Mail className="w-4 h-4 text-emerald-400" />
            : <MessageSquare className="w-4 h-4 text-emerald-400" />}
          <span className="text-zinc-100 font-medium text-sm">{isEmail ? "Email" : "Text"} {who}</span>
          <button
            onClick={onOpenLead}
            title="Open the full lead card to read the conversation"
            className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 transition-colors"
          >
            <ExternalLink className="w-3 h-3" /> Lead card
          </button>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-2.5">
          <ReplyPlanner
            kind="lead"
            contactKey={row.phone || row.email || undefined}
            plan={plan}
            busy={drafting}
            error={null}
            status={planStatus}
            onPlanChange={(next) => { setPlan(next); void aiDraft({ plan: next }) }}
            onRegenerate={(why) => void aiDraft(why ? { why } : undefined)}
            coach={{ read: coachRead, currentBody: body, onDraft: coach }}
          />
          {ryanNotes(row.notes) && (
            <div className="text-xs text-zinc-400 bg-zinc-900/60 rounded px-2.5 py-1.5">
              <span className="text-zinc-500">📝 Notes:</span> {ryanNotes(row.notes)}
            </div>
          )}
          {needsRecipient && (
            <input
              type="email"
              value={to}
              onChange={e => setTo(e.target.value)}
              placeholder="Recipient email (no address on file — add one)"
              className="w-full text-sm bg-zinc-900 border border-amber-800/60 rounded px-2.5 py-2 text-zinc-100 placeholder-amber-200/40 focus:outline-none focus:border-amber-600"
            />
          )}
          {isEmail && !threaded && (
            <input
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Subject"
              className="w-full text-sm bg-zinc-900 border border-zinc-800 rounded px-2.5 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
            />
          )}
          {isEmail && threaded && (
            <div className="text-xs text-zinc-500">↩ Replies on the existing email thread.</div>
          )}
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={isEmail ? 9 : 4}
            placeholder={isEmail ? "Write your email…" : "Write your text…"}
            className="w-full text-sm bg-zinc-900 border border-zinc-800 rounded px-2.5 py-2 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 resize-y"
          />
          {error && <div className="text-xs text-red-300">{error}</div>}
        </div>
        <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-2">
          <button
            onClick={() => void aiDraft()}
            disabled={drafting || sending}
            title="Generate a context-aware draft from the conversation + notes"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded bg-sky-900/40 border border-sky-900/60 text-sky-200 hover:bg-sky-900/60 text-xs font-medium transition-colors disabled:opacity-60"
          >
            {drafting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            AI Draft
          </button>
          <button
            onClick={send}
            disabled={sending || drafting || body.trim().length === 0}
            className="ml-auto inline-flex items-center gap-1.5 px-4 py-1.5 min-h-[34px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
          >
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Send {isEmail ? "email" : "text"}{sendSuffixFor(plan) ? ` ${sendSuffixFor(plan)}` : ""}
          </button>
        </div>
      </div>
    </div>
  )
}

// Full LeadsTab in an iframe overlay — same pattern as the old Drips tab so
// Ryan can read/act on the lead card without leaving the queue.
function LeadOverlay({ overlayKey, onClose }: { overlayKey: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])
  const src = `/leads-embed?phone=${encodeURIComponent(overlayKey)}&embed=1`
  const fullPageUrl = `/leads?phone=${encodeURIComponent(overlayKey)}`
  const headerLabel = overlayKey.startsWith("email:")
    ? overlayKey.slice("email:".length)
    : overlayKey.startsWith("thread:")
    ? "(email thread)"
    : formatPhone(overlayKey) ?? overlayKey
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-stretch justify-center p-2 sm:p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-3xl my-2 rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2 text-xs bg-zinc-950">
          <span className="text-zinc-200 font-medium">Lead</span>
          <span className="text-zinc-500 font-mono">{headerLabel}</span>
          <a
            href={fullPageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900"
            title="Open full Leads page in a new tab"
          >
            <ExternalLink className="w-3 h-3" /> Open
          </a>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200" aria-label="Close lead overlay">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <iframe src={src} className="flex-1 w-full bg-zinc-950" title="Lead detail" />
      </div>
    </div>
  )
}
