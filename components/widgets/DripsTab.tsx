"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bot, Loader2, RefreshCw, Check, X, Pencil, AlertTriangle, Clock,
  CalendarClock, Send, Mail, MessageSquare, Eye, Sparkles, SkipForward,
  ExternalLink,
} from "lucide-react"
import { formatPhone } from "@/lib/utils"

// Drips tab — one-stop shop for every drip in flight. Sections:
//   Late          pending too long (>24h queued)
//   Due           pending, queued recently — show full message + Send/Edit/Skip
//   Coming up     14-day forecast per cluster + already-approved-not-sent.
//                 Forecast rows have Prepare (engine generates draft + queues
//                 a pending row, message appears in Due) and Skip (advance
//                 counter, no send).
//   Recently sent last 7 days, view-only popout with full context.

interface DripCard {
  id: string
  lead_id: string
  touch_number: number
  campaign_type: string
  channel: "imessage" | "email"
  message: string
  subject: string | null
  status: "pending" | "approved" | "skipped" | "sent" | "failed"
  created_at: string
  approved_at: string | null
  sent_at: string | null
  error: string | null
  name: string | null
  caller_phone: string | null
  email: string | null
  source: string | null
}

interface ForecastItem {
  kind: "forecast"
  lead_id: string
  touch_number: number
  campaign_type: string
  channel: "imessage" | "email"
  due_at: string
  // Only due-now forecast rows get a Prepare button — the engine no-ops on
  // a touch that isn't due yet, so Prepare on a future row does nothing.
  due_now: boolean
  name: string | null
  caller_phone: string | null
  email: string | null
  source: string | null
  merged_siblings?: number
}

type ComingUpItem = DripCard | ForecastItem

interface DripsPayload {
  late: DripCard[]
  due: DripCard[]
  failed: DripCard[]
  comingUp: ComingUpItem[]
  recentSent: DripCard[]
  meta: { lateThresholdHours: number; forecastDays: number; sentHistoryDays: number; failedHistoryDays: number; generatedAt: string }
}

// formatPhone moved to lib/utils.ts.

function relativeFromNow(iso: string): string {
  const t = new Date(iso).getTime()
  const diffMs = t - Date.now()
  const abs = Math.abs(diffMs)
  const past = diffMs < 0
  const m = Math.round(abs / 60000)
  if (m < 60) return past ? `${m}m ago` : `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return past ? `${h}h ago` : `in ${h}h`
  const d = Math.round(h / 24)
  if (d < 14) return past ? `${d}d ago` : `in ${d}d`
  const w = Math.round(d / 7)
  return past ? `${w}w ago` : `in ${w}w`
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}

function ChannelIcon({ channel }: { channel: "imessage" | "email" }) {
  return channel === "email"
    ? <Mail className="w-3.5 h-3.5 text-zinc-400" />
    : <MessageSquare className="w-3.5 h-3.5 text-zinc-400" />
}

function displayName(item: { name: string | null; caller_phone: string | null; email: string | null }): string {
  return item.name || formatPhone(item.caller_phone) || item.email || "(unknown)"
}

// Which lookup key the LeadsTab deep-link should use when opening this card.
// Mirrors the group-key rule in groupLeads(): phone wins, else email — that's
// the value the deep-linked lead card matches against. Without the email
// fallback, clicking the name on an email-only drip card (no caller_phone)
// would no-op, which was the bug Ryan flagged 2026-05-17.
function leadOverlayKey(item: { caller_phone: string | null; email: string | null }): string | null {
  if (item.caller_phone) return item.caller_phone
  if (item.email) return `email:${item.email.toLowerCase()}`
  return null
}

export function DripsTab() {
  const [data, setData] = useState<DripsPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [actingOn, setActingOn] = useState<string | null>(null)
  const [bulkActing, setBulkActing] = useState<string | null>(null)
  const [editing, setEditing] = useState<Map<string, { message: string; subject: string }>>(new Map())
  const [sentPopout, setSentPopout] = useState<DripCard | null>(null)
  // Lead-detail overlay: clicking a name on any card opens the full LeadsTab
  // experience in a modal (iframe of /leads?phone=X&embed=1) without
  // navigating away from the Drips tab.
  const [leadOverlay, setLeadOverlay] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/drips", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const payload = await res.json() as DripsPayload
      setData(payload)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData()
    const id = setInterval(() => void fetchData(), 30000)
    return () => clearInterval(id)
  }, [fetchData])

  // Realtime sync with the embedded LeadsTab overlay: when Ryan flips
  // is_junk / is_dnc on a lead card inside the iframe, the server runs the
  // halt-outreach sweep on that cluster's drip_queue rows. The iframe then
  // postMessages us so we refetch instead of waiting up to 30s for the next
  // poll. Same-origin only (the iframe is /leads-embed on the same host).
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      const d = e.data
      if (d && typeof d === "object" && d.type === "lead-changed") {
        void fetchData()
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [fetchData])

  // Optimistic filter applied to ALL buckets that can hold a queue row keyed
  // by drip_queue.id: late, due, failed, and the approved-not-sent half of
  // comingUp. Without removing from comingUp, a row that was in Late/Due
  // would Send → flip to approved → reappear at the top of Coming up on the
  // next refetch, which feels like "the lead stayed at the top". After the
  // 30s auto-refresh (or the 4s post-action refresh) the server is source of
  // truth again; if the engine hasn't actually sent yet, the row resurfaces
  // (in Coming up), but the immediate user expectation — "the card I just
  // acted on goes away" — is satisfied.
  function removeRowFromAllBuckets(prev: DripsPayload | null, id: string): DripsPayload | null {
    if (!prev) return prev
    return {
      ...prev,
      late: prev.late.filter(c => c.id !== id),
      due: prev.due.filter(c => c.id !== id),
      failed: prev.failed.filter(c => c.id !== id),
      comingUp: prev.comingUp.filter(item => "kind" in item ? true : item.id !== id),
    }
  }

  async function sendNow(id: string) {
    setActingOn(id)
    try {
      const res = await fetch(`/api/drips/${id}/send`, { method: "POST" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok && res.status !== 202) throw new Error(body?.error || `HTTP ${res.status}`)
      setData(prev => removeRowFromAllBuckets(prev, id))
      // Engine runs async; give it a beat then refresh so the row lands in
      // Recently sent. 6s covers a typical iMessage send + Supabase write.
      setTimeout(() => void fetchData(), 6000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  async function skipPending(id: string) {
    setActingOn(id)
    // Optimistic first — the card disappears even if the server returns a
    // race-condition error (e.g., double-click hits a row that was already
    // skipped). The route is now idempotent on already-skipped, so a 200
    // confirms the state; we only surface real errors below.
    setData(prev => removeRowFromAllBuckets(prev, id))
    try {
      const res = await fetch("/api/leads/drip-queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "skip" }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      // Re-fetch so a genuinely failed Skip resurfaces the card.
      void fetchData()
    } finally {
      setActingOn(null)
    }
  }

  // Push a pending row out by N days. Touch number stays put; the GET
  // /api/drips response filters rows with snoozed_until > now() out of the
  // actionable buckets so the card disappears now and reappears when the
  // snooze elapses. The lead's cadence clock isn't touched — the engine
  // stamps last_drip_sent_at at send time, the canonical pattern.
  async function snoozePending(id: string, days: 1 | 3 | 7) {
    setActingOn(id)
    setData(prev => removeRowFromAllBuckets(prev, id))
    try {
      const res = await fetch("/api/leads/drip-queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "snooze", days }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void fetchData()
    } finally {
      setActingOn(null)
    }
  }

  async function saveEdit(id: string) {
    const draft = editing.get(id)
    if (!draft) return
    setActingOn(id)
    try {
      const res = await fetch("/api/leads/drip-queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "edit", message: draft.message, subject: draft.subject }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      setData(prev => {
        if (!prev) return prev
        const patch = (c: DripCard) => c.id === id ? { ...c, message: draft.message, subject: draft.subject || null } : c
        return { ...prev, late: prev.late.map(patch), due: prev.due.map(patch) }
      })
      setEditing(prev => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  function startEdit(card: DripCard) {
    setEditing(prev => {
      const next = new Map(prev)
      next.set(card.id, { message: card.message, subject: card.subject ?? "" })
      return next
    })
  }

  function cancelEdit(id: string) {
    setEditing(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }

  async function prepareForecast(leadId: string) {
    setActingOn(leadId)
    try {
      const res = await fetch("/api/drips/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok && res.status !== 202) throw new Error(body?.error || `HTTP ${res.status}`)
      // Engine spawn is async — give it a few seconds to generate the draft
      // and queue the row, then refresh so the new pending row surfaces.
      setTimeout(() => void fetchData(), 8000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  async function skipForecast(leadId: string) {
    setActingOn(leadId)
    try {
      const res = await fetch("/api/drips/forecast-skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      setData(prev => prev ? {
        ...prev,
        comingUp: prev.comingUp.filter(c => !("kind" in c) || c.lead_id !== leadId),
      } : prev)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  async function bulkSend(ids: string[], bucketKey: string) {
    if (ids.length === 0) return
    if (!confirm(`Send ${ids.length} drip${ids.length === 1 ? "" : "s"} now?`)) return
    setBulkActing(bucketKey)
    try {
      const res = await fetch("/api/drips/bulk-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok && res.status !== 202) throw new Error(body?.error || `HTTP ${res.status}`)
      const parts: string[] = []
      if (body.approved?.length) parts.push(`${body.approved.length} sending`)
      if (body.alreadyApproved?.length) parts.push(`${body.alreadyApproved.length} already approved`)
      if (body.skipped?.length) parts.push(`${body.skipped.length} auto-skipped (stale)`)
      if (body.failed?.length) parts.push(`${body.failed.length} failed`)
      if (parts.length > 0) setErr(parts.join(" · "))
      setTimeout(() => void fetchData(), 5000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkActing(null)
    }
  }

  // Failed rows: Retry re-runs the same send path ([id]/send accepts a
  // failed row, re-checks staleness, flips it back to approved + kicks the
  // engine). Dismiss skips it for good (counters already advanced when the
  // row was first queued, so dismissing just clears the queue).
  async function retryFailed(id: string) {
    setActingOn(id)
    try {
      const res = await fetch(`/api/drips/${id}/send`, { method: "POST" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok && res.status !== 202) throw new Error(body?.error || `HTTP ${res.status}`)
      setData(prev => removeRowFromAllBuckets(prev, id))
      setTimeout(() => void fetchData(), 6000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActingOn(null)
    }
  }

  async function dismissFailed(id: string) {
    setActingOn(id)
    setData(prev => removeRowFromAllBuckets(prev, id))
    try {
      const res = await fetch("/api/leads/drip-queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "skip" }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void fetchData()
    } finally {
      setActingOn(null)
    }
  }

  const lateIds = useMemo(() => data?.late.map(c => c.id) ?? [], [data])
  const dueIds = useMemo(() => data?.due.map(c => c.id) ?? [], [data])

  if (!data && loading) {
    return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" />Loading drips…</div>
  }
  if (!data) {
    return <div className="text-sm text-red-300">{err ?? "Failed to load drips"}</div>
  }

  const totalPending = data.late.length + data.due.length

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Bot className="w-4 h-4 text-zinc-400" />
          <span className="text-zinc-300">
            {totalPending} pending
            {data.failed.length > 0 && <span className="text-red-400"> · {data.failed.length} failed</span>}
            {" · "}{data.comingUp.length} coming up · {data.recentSent.length} sent (7d)
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

      <BucketHeader
        title="Late"
        count={data.late.length}
        tone="late"
        bulkLabel={data.late.length > 0 ? `Send all (${data.late.length})` : undefined}
        bulkActing={bulkActing === "late"}
        onBulk={() => void bulkSend(lateIds, "late")}
      />
      <div className="space-y-2">
        {data.late.map(card => (
          <PendingCard
            key={card.id}
            card={card}
            tone="late"
            acting={actingOn === card.id}
            editing={editing.get(card.id) || null}
            onStartEdit={() => startEdit(card)}
            onCancelEdit={() => cancelEdit(card.id)}
            onChangeEdit={(field, value) => setEditing(prev => {
              const next = new Map(prev)
              const cur = next.get(card.id) || { message: card.message, subject: card.subject ?? "" }
              next.set(card.id, { ...cur, [field]: value })
              return next
            })}
            onSaveEdit={() => void saveEdit(card.id)}
            onSend={() => void sendNow(card.id)}
            onSkip={() => void skipPending(card.id)}
            onSnooze={(days) => void snoozePending(card.id, days)}
            onOpenLead={() => { const k = leadOverlayKey(card); if (k) setLeadOverlay(k) }}
          />
        ))}
        {data.late.length === 0 && (
          <div className="text-xs text-zinc-600 pl-3">No late drips.</div>
        )}
      </div>

      <BucketHeader
        title="Due now"
        count={data.due.length}
        tone="due"
        bulkLabel={data.due.length > 0 ? `Send all (${data.due.length})` : undefined}
        bulkActing={bulkActing === "due"}
        onBulk={() => void bulkSend(dueIds, "due")}
      />
      <div className="space-y-2">
        {data.due.map(card => (
          <PendingCard
            key={card.id}
            card={card}
            tone="due"
            acting={actingOn === card.id}
            editing={editing.get(card.id) || null}
            onStartEdit={() => startEdit(card)}
            onCancelEdit={() => cancelEdit(card.id)}
            onChangeEdit={(field, value) => setEditing(prev => {
              const next = new Map(prev)
              const cur = next.get(card.id) || { message: card.message, subject: card.subject ?? "" }
              next.set(card.id, { ...cur, [field]: value })
              return next
            })}
            onSaveEdit={() => void saveEdit(card.id)}
            onSend={() => void sendNow(card.id)}
            onSkip={() => void skipPending(card.id)}
            onSnooze={(days) => void snoozePending(card.id, days)}
            onOpenLead={() => { const k = leadOverlayKey(card); if (k) setLeadOverlay(k) }}
          />
        ))}
        {data.due.length === 0 && (
          <div className="text-xs text-zinc-600 pl-3">Nothing due.</div>
        )}
      </div>

      {data.failed.length > 0 && (
        <>
          <BucketHeader title="Failed" count={data.failed.length} tone="failed" />
          <div className="space-y-2">
            {data.failed.map(card => (
              <FailedCard
                key={card.id}
                card={card}
                acting={actingOn === card.id}
                onRetry={() => void retryFailed(card.id)}
                onDismiss={() => void dismissFailed(card.id)}
                onOpenLead={() => { const k = leadOverlayKey(card); if (k) setLeadOverlay(k) }}
              />
            ))}
          </div>
        </>
      )}

      <BucketHeader title={`Coming up — next ${data.meta.forecastDays} days`} count={data.comingUp.length} tone="upcoming" />
      <div className="space-y-2">
        {data.comingUp.map(item =>
          "kind" in item ? (
            <ForecastRow
              key={`f:${item.lead_id}:${item.touch_number}`}
              item={item}
              acting={actingOn === item.lead_id}
              onPrepare={() => void prepareForecast(item.lead_id)}
              onSkip={() => void skipForecast(item.lead_id)}
              onOpenLead={() => { const k = leadOverlayKey(item); if (k) setLeadOverlay(k) }}
            />
          ) : (
            <ApprovedRow
              key={item.id}
              card={item}
              acting={actingOn === item.id}
              onSend={() => void sendNow(item.id)}
              onOpenLead={() => { const k = leadOverlayKey(item); if (k) setLeadOverlay(k) }}
            />
          )
        )}
        {data.comingUp.length === 0 && (
          <div className="text-xs text-zinc-600 pl-3">Nothing scheduled in the next {data.meta.forecastDays} days.</div>
        )}
      </div>

      <BucketHeader title={`Recently sent — last ${data.meta.sentHistoryDays} days`} count={data.recentSent.length} tone="sent" />
      <div className="space-y-1.5">
        {data.recentSent.map(card => (
          <SentRow key={card.id} card={card} onView={() => setSentPopout(card)} />
        ))}
        {data.recentSent.length === 0 && (
          <div className="text-xs text-zinc-600 pl-3">No drips sent in the last {data.meta.sentHistoryDays} days.</div>
        )}
      </div>

      {sentPopout && (
        <SentPopout
          card={sentPopout}
          onClose={() => setSentPopout(null)}
          onOpenLead={() => {
            const k = leadOverlayKey(sentPopout)
            setSentPopout(null)
            if (k) setLeadOverlay(k)
          }}
        />
      )}

      {leadOverlay && (
        <LeadOverlay phone={leadOverlay} onClose={() => setLeadOverlay(null)} />
      )}
    </div>
  )
}

// Full LeadsTab in an iframe overlay so Ryan can act on a lead without
// leaving the Drips tab. Renders /leads?phone=X&embed=1 — the embed flag
// hides the leads-page sub-nav so only the deep-linked card shows. Cookies
// are same-origin so the middleware auth carries into the iframe.
function LeadOverlay({ phone, onClose }: { phone: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  // The "phone" prop is actually the group key from LeadsTab.groupLeads():
  // a phone number for phone-bearing leads, "email:<addr>" for email-only.
  // LeadsTab's deep-link effect matches against group.phone directly, so
  // either form works as the ?phone= param.
  const src = `/leads-embed?phone=${encodeURIComponent(phone)}&embed=1`
  const fullPageUrl = `/leads?phone=${encodeURIComponent(phone)}`
  const headerLabel = phone.startsWith("email:")
    ? phone.slice("email:".length)
    : phone.startsWith("thread:")
    ? "(email thread)"
    : formatPhone(phone) ?? phone
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-stretch justify-center p-2 sm:p-4" onClick={onClose}>
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
            <ExternalLink className="w-3 h-3" />
            Open
          </a>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200"
            aria-label="Close lead overlay"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <iframe
          src={src}
          className="flex-1 w-full bg-zinc-950"
          title="Lead detail"
        />
      </div>
    </div>
  )
}

function BucketHeader({
  title, count, tone, bulkLabel, bulkActing, onBulk,
}: {
  title: string
  count: number
  tone: "late" | "due" | "failed" | "upcoming" | "sent"
  bulkLabel?: string
  bulkActing?: boolean
  onBulk?: () => void
}) {
  const toneCls = {
    late: "text-red-300",
    due: "text-amber-300",
    failed: "text-red-400",
    upcoming: "text-sky-300",
    sent: "text-zinc-400",
  }[tone]
  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      <div className={`text-sm font-semibold ${toneCls}`}>
        {title} <span className="text-zinc-500 font-normal">· {count}</span>
      </div>
      {bulkLabel && onBulk && (
        <button
          onClick={onBulk}
          disabled={bulkActing}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs bg-emerald-900/40 border border-emerald-900/60 text-emerald-200 hover:bg-emerald-900/60 transition-colors disabled:opacity-60"
        >
          {bulkActing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          {bulkLabel}
        </button>
      )}
    </div>
  )
}

function PendingCard({
  card, tone, acting, editing,
  onStartEdit, onCancelEdit, onChangeEdit, onSaveEdit,
  onSend, onSkip, onSnooze, onOpenLead,
}: {
  card: DripCard
  tone: "late" | "due"
  acting: boolean
  editing: { message: string; subject: string } | null
  onStartEdit: () => void
  onCancelEdit: () => void
  onChangeEdit: (field: "message" | "subject", value: string) => void
  onSaveEdit: () => void
  onSend: () => void
  onSkip: () => void
  onSnooze: (days: 1 | 3 | 7) => void
  onOpenLead: () => void
}) {
  const isEditing = editing != null
  const toneCls = tone === "late"
    ? "border-red-900/50 bg-red-950/20"
    : "border-zinc-800 bg-zinc-950"
  const ageLabel = relativeFromNow(card.created_at)
  return (
    <div className={`rounded-md border ${toneCls} overflow-hidden`}>
      <div className="px-3 py-2 border-b border-zinc-900 flex items-center gap-2 text-xs">
        <ChannelIcon channel={card.channel} />
        <button
          type="button"
          onClick={onOpenLead}
          disabled={!card.caller_phone}
          className="text-zinc-200 font-medium hover:text-emerald-400 hover:underline disabled:no-underline disabled:hover:text-zinc-200 underline-offset-2 text-left"
        >
          {displayName(card)}
        </button>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">#{card.touch_number} {card.channel === "imessage" ? "iMessage" : "Email"}</span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-500">{card.campaign_type}</span>
        <span className="text-zinc-600">·</span>
        <span className={tone === "late" ? "text-red-300" : "text-zinc-500"}>queued {ageLabel}</span>
      </div>
      {!isEditing && card.subject && (
        <div className="px-3 pt-2 text-xs text-zinc-500">Subject: <span className="text-zinc-300">{card.subject}</span></div>
      )}
      {!isEditing ? (
        <div className="px-3 py-2 text-sm text-zinc-200 bg-zinc-900/60 whitespace-pre-wrap break-words mx-3 my-2 rounded">
          {card.message}
        </div>
      ) : (
        <div className="px-3 py-2 space-y-2">
          {(card.channel === "email" || card.subject) && (
            <input
              value={editing.subject}
              onChange={e => onChangeEdit("subject", e.target.value)}
              placeholder="Subject"
              className="w-full text-sm bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-zinc-700"
            />
          )}
          <textarea
            value={editing.message}
            onChange={e => onChangeEdit("message", e.target.value)}
            rows={Math.max(4, Math.min(12, editing.message.split("\n").length + 1))}
            className="w-full text-sm bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-zinc-700 resize-y"
          />
        </div>
      )}
      <div className="px-3 py-2 border-t border-zinc-900 flex items-center justify-end gap-2">
        {!isEditing ? (
          <>
            <button
              onClick={onStartEdit}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors disabled:opacity-60"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </button>
            <div className="inline-flex items-center rounded border border-zinc-800 bg-zinc-900 overflow-hidden" title="Snooze this drip — push the send date out by N days, touch number unchanged">
              <span className="px-2 py-1.5 min-h-[34px] inline-flex items-center text-[10px] uppercase tracking-wide text-zinc-500 border-r border-zinc-800">
                <Clock className="w-3 h-3 mr-1" />Snooze
              </span>
              {[1, 3, 7].map((d, i) => (
                <button
                  key={d}
                  onClick={() => onSnooze(d as 1 | 3 | 7)}
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
              {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
              Skip
            </button>
            <button
              onClick={onSend}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
            >
              {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Send
            </button>
          </>
        ) : (
          <>
            <button
              onClick={onCancelEdit}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 text-xs font-medium transition-colors disabled:opacity-60"
            >
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
            <button
              onClick={onSaveEdit}
              disabled={acting || editing.message.trim().length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
            >
              {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Save edit
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function ForecastRow({
  item, acting, onPrepare, onSkip, onOpenLead,
}: {
  item: ForecastItem
  acting: boolean
  onPrepare: () => void
  onSkip: () => void
  onOpenLead: () => void
}) {
  return (
    <div className="px-3 py-2 rounded-md border border-zinc-800 bg-zinc-950 flex items-center gap-2 text-xs">
      <ChannelIcon channel={item.channel} />
      <button
        type="button"
        onClick={onOpenLead}
        disabled={!item.caller_phone}
        className="text-zinc-200 font-medium hover:text-emerald-400 hover:underline disabled:no-underline disabled:hover:text-zinc-200 underline-offset-2 text-left"
      >
        {displayName(item)}
      </button>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-400">#{item.touch_number} {item.channel === "imessage" ? "iMessage" : "Email"}</span>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-500">{item.campaign_type}</span>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-500 inline-flex items-center gap-1">
        <CalendarClock className="w-3 h-3" />
        {relativeFromNow(item.due_at)}
      </span>
      {item.merged_siblings && item.merged_siblings > 0 ? (
        <span className="text-zinc-600">·</span>
      ) : null}
      {item.merged_siblings && item.merged_siblings > 0 ? (
        <span title="Other lead rows on this cluster are also stamped — engine duplicate-fire risk" className="text-amber-400 text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 border border-amber-900/50">
          +{item.merged_siblings} merged
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onSkip}
          disabled={acting}
          title="Advance the lead's drip counter without sending"
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 transition-colors disabled:opacity-60"
        >
          {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SkipForward className="w-3.5 h-3.5" />}
          Skip
        </button>
        {item.due_now ? (
          <button
            onClick={onPrepare}
            disabled={acting}
            title="Generate the draft via Haiku now — appears in Due bucket for review"
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-sky-900/40 border border-sky-900/60 text-sky-200 hover:bg-sky-900/60 transition-colors disabled:opacity-60"
          >
            {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            Prepare
          </button>
        ) : (
          <span className="text-[10px] text-zinc-600 px-1.5" title="The engine drafts this automatically once it's due — Prepare only works on due rows.">
            auto-drafts when due
          </span>
        )}
      </div>
    </div>
  )
}

function ApprovedRow({ card, acting, onSend, onOpenLead }: { card: DripCard; acting: boolean; onSend: () => void; onOpenLead: () => void }) {
  return (
    <div className="px-3 py-2 rounded-md border border-emerald-900/50 bg-emerald-950/10 flex items-center gap-2 text-xs">
      <ChannelIcon channel={card.channel} />
      <button
        type="button"
        onClick={onOpenLead}
        disabled={!card.caller_phone}
        className="text-zinc-200 font-medium hover:text-emerald-400 hover:underline disabled:no-underline disabled:hover:text-zinc-200 underline-offset-2 text-left"
      >
        {displayName(card)}
      </button>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-400">#{card.touch_number} {card.channel === "imessage" ? "iMessage" : "Email"}</span>
      <span className="text-zinc-600">·</span>
      <span className="text-emerald-300 inline-flex items-center gap-1">
        <Check className="w-3 h-3" />
        approved {card.approved_at ? relativeFromNow(card.approved_at) : ""}
      </span>
      <button
        onClick={onSend}
        disabled={acting}
        className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
      >
        {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        Send now
      </button>
    </div>
  )
}

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
      <div className="px-3 py-2 border-b border-zinc-900 flex items-center gap-2 text-xs">
        <ChannelIcon channel={card.channel} />
        <button
          type="button"
          onClick={onOpenLead}
          disabled={!card.caller_phone}
          className="text-zinc-200 font-medium hover:text-emerald-400 hover:underline disabled:no-underline disabled:hover:text-zinc-200 underline-offset-2 text-left"
        >
          {displayName(card)}
        </button>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">#{card.touch_number} {card.channel === "imessage" ? "iMessage" : "Email"}</span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-500">{card.campaign_type}</span>
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
          title="Skip this touch for good — the lead's drip cadence already moved past it"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 text-xs font-medium transition-colors disabled:opacity-60"
        >
          {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
          Dismiss
        </button>
        <button
          onClick={onRetry}
          disabled={acting}
          title="Re-run the send — re-checks staleness, then dispatches via the engine"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
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
      <span className="text-zinc-300 font-medium">{displayName(card)}</span>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-500">#{card.touch_number} {card.channel === "imessage" ? "iMessage" : "Email"}</span>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-500 inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {relativeFromNow(card.sent_at || card.created_at)}</span>
      <button
        onClick={onView}
        className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 transition-colors"
      >
        <Eye className="w-3.5 h-3.5" />
        View
      </button>
    </div>
  )
}

function SentPopout({ card, onClose, onOpenLead }: { card: DripCard; onClose: () => void; onOpenLead: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <ChannelIcon channel={card.channel} />
          <span className="text-zinc-100 font-medium">{displayName(card)}</span>
          <span className="text-zinc-600">·</span>
          <span className="text-xs text-zinc-400">#{card.touch_number} {card.channel === "imessage" ? "iMessage" : "Email"}</span>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div className="text-xs text-zinc-500">
            <div>Sent: <span className="text-zinc-300">{formatAbsolute(card.sent_at || card.created_at)}</span></div>
            <div>Campaign: <span className="text-zinc-300">{card.campaign_type}</span></div>
            {card.source && <div>Source: <span className="text-zinc-300">{card.source}</span></div>}
            {card.caller_phone && <div>Phone: <span className="text-zinc-300">{formatPhone(card.caller_phone)}</span></div>}
            {card.email && <div>Email: <span className="text-zinc-300">{card.email}</span></div>}
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
        <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
          {card.caller_phone && (
            <button
              onClick={onOpenLead}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
            >
              Open lead
            </button>
          )}
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-xs font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
