"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Phone, PhoneOutgoing, Bot, Mail, MessageSquare, Send, Pencil, X, Check,
  Clock, Loader2, RefreshCw, AlertTriangle, ChevronDown, ChevronRight,
  Sparkles, SkipForward, Eye, ExternalLink, CalendarClock,
} from "lucide-react"
import { formatPhone } from "@/lib/utils"
import {
  classifyUrgency, describeTouchWhen, touchSortKey,
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
  status: string
  temperature: "hot" | "warm" | "cold" | null
  notes: string | null
  emailReplyLeadId: string | null
  primary: NextTouch
  secondary: NextTouch | null
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

// Worklist sort within a bucket: calls before drips, then hot→warm→cold,
// then soonest-due. (Ryan's call: order the day's work by temperature.)
const TEMP_RANK: Record<string, number> = { hot: 0, warm: 1, cold: 2 }
function tempRank(t: string | null): number {
  return t ? TEMP_RANK[t] ?? 3 : 3
}
function sortWorklist(rows: ContactRow[]): ContactRow[] {
  return [...rows].sort((a, b) => {
    const k = (a.primary.kind === "call" ? 0 : 1) - (b.primary.kind === "call" ? 0 : 1)
    if (k !== 0) return k
    const t = tempRank(a.temperature) - tempRank(b.temperature)
    if (t !== 0) return t
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

export function FollowUpsTab() {
  const [data, setData] = useState<FollowUpsPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
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

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await fetch("/api/follow-ups", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json() as FollowUpsPayload)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData()
    const id = setInterval(() => void fetchData(true), 30000)
    return () => clearInterval(id)
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

  function showToast(text: string) {
    setToast(text)
    window.setTimeout(() => setToast(prev => (prev === text ? null : prev)), 3500)
  }

  // Drop a row from the visible list immediately; the next refetch is the
  // source of truth (a both-row with a remaining touch reappears).
  function dropRow(clusterKey: string) {
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
        setErr((body as { error?: string })?.error || "Contact had activity since this was drafted — pick Regenerate / Send anyway / Skip.")
        void fetchData(true)
        return
      }
      if (!res.ok && res.status !== 202) throw new Error((body as { error?: string })?.error || `HTTP ${res.status}`)
      showToast(force ? "Sending anyway ✓" : "Sent ✓")
      dropRow(row.clusterKey)
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
      showToast("Regenerating drip with the latest context")
      setTimeout(() => void fetchData(true), 8000)
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
      showToast("Drafting drip — it'll appear ready to send")
      setTimeout(() => void fetchData(true), 8000)
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
      showToast("Calling — clear this once you've connected")
    } catch (e) {
      setErr(`Call failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setActingOn(null)
    }
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

  // Park a lead on the slow long-term-nurture campaign — switches the
  // cadence to ~60/120/180/240/365/540-day check-ins + a 6-month follow-up,
  // dropping the contact off the active worklist.
  async function longTermNurture(row: ContactRow) {
    if (!confirm(
      `Move ${row.name || "this lead"} to long-term nurture? Switches to slow check-ins ` +
      `(~60d / 120d / 180d …) plus a 6-month follow-up, and drops them off your active list.`
    )) return
    setActingOn(row.clusterKey)
    dropRow(row.clusterKey)
    try {
      const res = await fetch(`/api/leads/${row.leadId}/long-term-nurture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      showToast("Moved to long-term nurture")
      void fetchData(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void fetchData(true)
    } finally {
      setActingOn(null)
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
    for (const r of data?.rows ?? []) out[classifyUrgency(r.primary, now)].push(r)
    return {
      overdue: sortWorklist(out.overdue),
      today: sortWorklist(out.today),
      soon: sortWorklist(out.soon),
      future: sortWorklist(out.future),
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

  const dueCount = buckets.overdue.length + buckets.today.length
  const cardProps = {
    actingOn, editing, intervalOpenFor,
    onOpenLead: (row: ContactRow) => { const k = leadOverlayKey(row); if (k) setLeadOverlay(k) },
    onSendDrip: sendDrip,
    onRegenerateDrip: regenerateDrip,
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
    onCall: placeCall,
    onSnoozeContact: snoozeContact,
    onDoneCall: doneCall,
    onPickInterval: applyInterval,
    onEmail: (row: ContactRow) => setComposeFor({ row, channel: "email" }),
    onText: (row: ContactRow) => setComposeFor({ row, channel: "text" }),
    onLongTermNurture: longTermNurture,
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
            {(buckets.soon.length + buckets.future.length) > 0 &&
              <span className="text-zinc-500"> · {buckets.soon.length + buckets.future.length} upcoming</span>}
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

      {isEmpty && (
        <div className="text-sm text-zinc-500 py-12 text-center">
          🎉 All caught up — no calls or drips scheduled.
        </div>
      )}

      {/* Today's work — always expanded. */}
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
        <div className="text-sm text-zinc-500 py-6 text-center">Nothing due today — upcoming work is below.</div>
      )}

      {/* Everything else — collapsed by default. */}
      <Collapsible
        id="soon" label="This week" count={buckets.soon.length}
        open={!!openSections.soon} onToggle={() => setOpenSections(s => ({ ...s, soon: !s.soon }))}
      >
        <div className="space-y-2">
          {buckets.soon.map(row => <ContactCard key={row.clusterKey} row={row} {...cardProps} />)}
        </div>
      </Collapsible>
      <Collapsible
        id="future" label="Upcoming" count={buckets.future.length}
        open={!!openSections.future} onToggle={() => setOpenSections(s => ({ ...s, future: !s.future }))}
      >
        <div className="space-y-2">
          {buckets.future.map(row => <ContactCard key={row.clusterKey} row={row} {...cardProps} />)}
        </div>
      </Collapsible>
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

function SectionHeader({ label, count, tone }: { label: string; count: number; tone: "overdue" | "today" }) {
  const cls = tone === "overdue" ? "text-red-300" : "text-amber-300"
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
  onOpenLead: (row: ContactRow) => void
  onSendDrip: (row: ContactRow, queueId: string, opts?: { force?: boolean }) => void
  onRegenerateDrip: (row: ContactRow, queueId: string) => void
  onQueueAction: (row: ContactRow, queueId: string, action: "skip" | "snooze", days?: 1 | 3 | 7) => void
  onStartEdit: (queueId: string, t: NextTouch) => void
  onChangeEdit: (queueId: string, field: "message" | "subject", value: string) => void
  onCancelEdit: (queueId: string) => void
  onSaveEdit: (row: ContactRow, queueId: string) => void
  onPrepare: (row: ContactRow) => void
  onSkipForecast: (row: ContactRow) => void
  onCall: (row: ContactRow) => void
  onSnoozeContact: (row: ContactRow, days: number) => void
  onDoneCall: (row: ContactRow) => void
  onPickInterval: (row: ContactRow, opt: { key: string; label: string; days?: number; months?: number }) => void
  onEmail: (row: ContactRow) => void
  onText: (row: ContactRow) => void
  onLongTermNurture: (row: ContactRow) => void
}

function ContactCard({ row, ...h }: { row: ContactRow } & CardHandlers) {
  const acting = h.actingOn === row.clusterKey
  const callTouch =
    row.primary.kind === "call" ? row.primary : row.secondary?.kind === "call" ? row.secondary : null
  const dripTouch =
    row.primary.kind === "drip" ? row.primary : row.secondary?.kind === "drip" ? row.secondary : null
  const overdue = classifyUrgency(row.primary) === "overdue"
  const temp = row.temperature ? TEMP_BADGE[row.temperature] : null

  return (
    <div className={`rounded-md border overflow-hidden ${overdue ? "border-red-900/50 bg-red-950/20" : "border-zinc-800 bg-zinc-950"}`}>
      {/* header */}
      <div className="px-3 py-2 flex items-center gap-2 text-xs flex-wrap">
        {temp && <span className={temp.cls} title={row.temperature ?? ""}>{temp.emoji}</span>}
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
        <button
          onClick={() => h.onLongTermNurture(row)}
          disabled={acting}
          title="Park this lead — switch to the slow long-term-nurture cadence"
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900 transition-colors disabled:opacity-60 shrink-0"
        >
          <CalendarClock className="w-3.5 h-3.5" /> Long-term nurture
        </button>
      </div>

      {/* call block */}
      {callTouch && (
        <CallBlock
          row={row} touch={callTouch} acting={acting}
          intervalOpen={h.intervalOpenFor === row.clusterKey}
          onCall={() => h.onCall(row)}
          onSnooze={(d) => h.onSnoozeContact(row, d)}
          onDone={() => h.onDoneCall(row)}
          onPickInterval={(opt) => h.onPickInterval(row, opt)}
          onEmail={() => h.onEmail(row)}
          onText={() => h.onText(row)}
        />
      )}

      {/* drip block */}
      {dripTouch && (
        <DripBlock
          row={row} touch={dripTouch} acting={acting} hasCallAbove={!!callTouch}
          editDraft={dripTouch.queueId ? h.editing.get(dripTouch.queueId) ?? null : null}
          onOpenLead={() => h.onOpenLead(row)}
          onSend={(opts) => dripTouch.queueId && h.onSendDrip(row, dripTouch.queueId, opts)}
          onRegenerate={() => dripTouch.queueId && h.onRegenerateDrip(row, dripTouch.queueId)}
          onSkip={() => dripTouch.queueId && h.onQueueAction(row, dripTouch.queueId, "skip")}
          onSnooze={(d) => h.onSnoozeContact(row, d)}
          onStartEdit={() => dripTouch.queueId && h.onStartEdit(dripTouch.queueId, dripTouch)}
          onChangeEdit={(f, v) => dripTouch.queueId && h.onChangeEdit(dripTouch.queueId, f, v)}
          onCancelEdit={() => dripTouch.queueId && h.onCancelEdit(dripTouch.queueId)}
          onSaveEdit={() => dripTouch.queueId && h.onSaveEdit(row, dripTouch.queueId)}
          onPrepare={() => h.onPrepare(row)}
          onSkipForecast={() => h.onSkipForecast(row)}
        />
      )}
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
  row, touch, acting, intervalOpen, onCall, onSnooze, onDone, onPickInterval, onEmail, onText,
}: {
  row: ContactRow
  touch: NextTouch
  acting: boolean
  intervalOpen: boolean
  onCall: () => void
  onSnooze: (days: number) => void
  onDone: () => void
  onPickInterval: (opt: { key: string; label: string; days?: number; months?: number }) => void
  onEmail: () => void
  onText: () => void
}) {
  const overdue = classifyUrgency(touch) === "overdue"
  return (
    <div className="px-3 py-2 border-t border-zinc-900">
      <div className="flex items-center gap-1.5 text-xs">
        <Phone className="w-3.5 h-3.5 text-emerald-400" />
        <span className="text-zinc-300 font-medium">Follow-up call</span>
        <span className="text-zinc-600">·</span>
        <span className={overdue ? "text-red-300" : "text-amber-300"}>{describeTouchWhen(touch)}</span>
      </div>
      {touch.reason && <div className="mt-1 text-xs text-zinc-400 italic">{touch.reason}</div>}
      <div className="mt-2 flex items-center gap-1.5 flex-wrap justify-end">
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
        {row.email && (
          <button
            onClick={onEmail}
            disabled={acting}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-emerald-900/30 border border-emerald-800/60 text-emerald-200 hover:bg-emerald-900/50 text-xs font-medium transition-colors disabled:opacity-60"
          >
            <Mail className="w-3.5 h-3.5" /> Email
          </button>
        )}
        {row.phone && (
          <button
            onClick={onText}
            disabled={acting}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-emerald-900/30 border border-emerald-800/60 text-emerald-200 hover:bg-emerald-900/50 text-xs font-medium transition-colors disabled:opacity-60"
          >
            <MessageSquare className="w-3.5 h-3.5" /> Text
          </button>
        )}
        {/* Inline segmented control — no popup, so it can't be clipped by
            the card's overflow-hidden or hidden behind the next card. */}
        <div className="inline-flex items-center rounded border border-zinc-800 bg-zinc-900 overflow-hidden" title="Snooze — defers this contact's call and drip">
          <span className="px-2 py-1.5 min-h-[34px] inline-flex items-center text-[10px] uppercase tracking-wide text-zinc-500 border-r border-zinc-800">
            <Clock className="w-3 h-3 mr-1" />Snooze
          </span>
          {[1, 3, 7].map((d, i) => (
            <button
              key={d}
              onClick={() => onSnooze(d)}
              disabled={acting}
              className={`px-2 py-1.5 min-h-[34px] text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors disabled:opacity-60 ${i > 0 ? "border-l border-zinc-800" : ""}`}
            >
              {d}d
            </button>
          ))}
        </div>
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
  onOpenLead, onSend, onRegenerate, onSkip, onSnooze,
  onStartEdit, onChangeEdit, onCancelEdit, onSaveEdit,
  onPrepare, onSkipForecast,
}: {
  row: ContactRow
  touch: NextTouch
  acting: boolean
  hasCallAbove: boolean
  editDraft: { message: string; subject: string } | null
  onOpenLead: () => void
  onSend: (opts?: { force?: boolean }) => void
  onRegenerate: () => void
  onSkip: () => void
  onSnooze: (days: 1 | 3 | 7) => void
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
            <span className="inline-flex items-center gap-1 text-amber-400" title="A non-drip event landed on this cluster after this draft was written — Send will be auto-skipped. Use Regenerate to draft a fresh message, or Send anyway to override.">
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
        {touch.isQueued && !isEditing && (
          <>
            <button
              onClick={onStartEdit}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors disabled:opacity-60"
            >
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
            <div className="inline-flex items-center rounded border border-zinc-800 bg-zinc-900 overflow-hidden" title="Snooze — defers this contact's call and drip">
              <span className="px-2 py-1.5 min-h-[34px] inline-flex items-center text-[10px] uppercase tracking-wide text-zinc-500 border-r border-zinc-800">
                <Clock className="w-3 h-3 mr-1" />Snooze
              </span>
              {([1, 3, 7] as const).map((d, i) => (
                <button
                  key={d}
                  onClick={() => onSnooze(d)}
                  disabled={acting}
                  className={`px-2 py-1.5 min-h-[34px] text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors disabled:opacity-60 ${i > 0 ? "border-l border-zinc-800" : ""}`}
                >
                  {d}d
                </button>
              ))}
            </div>
            <button
              onClick={onSkip}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 text-xs font-medium transition-colors disabled:opacity-60"
            >
              <X className="w-3.5 h-3.5" /> Skip
            </button>
            {stale && (
              <button
                onClick={onRegenerate}
                disabled={acting}
                title="Skip this stale draft and ask the engine for a fresh one with the latest context."
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-sky-900/40 border border-sky-900/60 text-sky-200 hover:bg-sky-900/60 text-xs font-medium transition-colors disabled:opacity-60"
              >
                {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Regenerate
              </button>
            )}
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
  const [drafting, setDrafting] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  async function aiDraft() {
    setDrafting(true)
    setError(null)
    try {
      const res = await fetch(`/api/leads/${row.leadId}/draft-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: isEmail ? "email" : "imessage" }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setBody(data.message || "")
      if (isEmail && data.subject && !threaded) setSubject(data.subject)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDrafting(false)
    }
  }

  async function send() {
    const text = body.trim()
    if (!text) return
    if (isEmail && !threaded && !subject.trim()) {
      setError("Subject is required for a new email.")
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
          body: JSON.stringify({ phone: row.phone, message: text, source: row.source }),
        })
      } else if (threaded) {
        res = await fetch("/api/leads/email-reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId: row.emailReplyLeadId, message: text }),
        })
      } else {
        res = await fetch(`/api/leads/${row.leadId}/send-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: subject.trim(), body: text }),
        })
      }
      const data = await res.json().catch(() => ({}))
      // /send returns {success}; /email-reply + /send-email return {ok}.
      if (!res.ok || !(data.success || data.ok)) throw new Error(data.error || `HTTP ${res.status}`)
      // Manual outreach is a touch: reset the drip cadence + skip queued
      // drips (manual_touch) so the contact isn't dragged back to the top by
      // a stale drip. Fires even with no existing follow-up row — a drip-only
      // contact still needs the reset. When a follow-up date does exist, roll
      // it forward a week too. Best-effort — the message has already sent.
      try {
        await fetch("/api/leads", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: row.followupLeadId ?? row.leadId,
            manual_touch: true,
            ...(row.followupLeadId
              ? {
                  recommended_followup_date: dateFromInterval({ days: 7 }),
                  followup_reason: `Followed up via ${isEmail ? "email" : "text"}`,
                }
              : {}),
          }),
        })
      } catch {
        /* message already sent — a stale follow-up just stays put */
      }
      onSent(isEmail ? "Email sent — next follow-up in 1 week" : "Text sent — next follow-up in 1 week")
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
          {row.notes && (
            <div className="text-xs text-zinc-400 bg-zinc-900/60 rounded px-2.5 py-1.5">
              <span className="text-zinc-500">📝 Notes:</span> {row.notes}
            </div>
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
            onClick={aiDraft}
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
            Send {isEmail ? "email" : "text"}
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
