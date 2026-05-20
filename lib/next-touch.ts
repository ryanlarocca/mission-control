// Shared "next touch" resolver — the single definition of *when a contact
// is next being contacted, and how*. It unifies the two outreach systems
// that used to live in separate tabs:
//
//   drips      — automated cadence messages (the drip engine). Either
//                already queued in drip_queue awaiting Ryan's send, or
//                forecast from the campaign cadence + last_drip_sent_at.
//   follow-ups — manual call reminders (recommended_followup_date), set by
//                the AI call analyzer / note extractor.
//
// Both the merged Follow Ups tab (via /api/follow-ups) and the lead card's
// "Next touch" pill run off this one resolver, so the worklist and the card
// can never disagree about what happens next for a contact.
//
// Pure module — no React, no DB, no timers. Safe to import from server
// routes and client components alike. The one timing subtlety: a `call`
// touch's `due` is a bare calendar date (YYYY-MM-DD) and a `drip` touch's
// `due` is a full ISO instant. Day-bucketing for calls must therefore
// happen in the *consumer's* timezone — see classifyUrgency.

import {
  getCampaign,
  getNextTouch,
  effectiveChannelForTouch,
  DRIP_STOP_STATUSES,
} from "@/lib/drip-campaigns"

export type NextTouchKind = "call" | "drip"
export type NextTouchChannel = "imessage" | "email"
export type NextTouchUrgency = "overdue" | "today" | "soon" | "future"

export interface NextTouch {
  kind: NextTouchKind
  // call  → bare calendar date "YYYY-MM-DD" (no time; bucket in local TZ)
  // drip  → full ISO instant (timezone-agnostic)
  due: string
  // Human reason — followup_reason for calls, "Drip touch #N" for drips.
  reason: string | null
  // Drip-only fields (null on call touches).
  channel: NextTouchChannel | null
  touchNumber: number | null
  campaignType: string | null
  // True when a real drip_queue row is waiting (pending/approved) — Ryan
  // can Send it right now. False for a pure cadence forecast.
  isQueued: boolean
  queueId: string | null
  // The generated drip message — present only for a queued drip (the
  // engine hasn't written one yet for a pure forecast). Lets the worklist
  // preview and Edit the message without a second fetch.
  message: string | null
  subject: string | null
}

export interface NextTouchSummary {
  // Soonest actionable touch. Null when the contact has nothing scheduled.
  primary: NextTouch | null
  // The other-kind touch when one is also scheduled (e.g. a call still on
  // the calendar while a drip is the primary). Drives the card's faint
  // "then …" second line.
  secondary: NextTouch | null
}

// A live drip_queue row (status pending/approved) for the contact. When
// present the resolver uses it verbatim instead of forecasting — it is
// already actionable.
export interface QueuedDrip {
  id: string
  touchNumber: number
  channel: NextTouchChannel
  campaignType: string
  createdAt: string // ISO — when the engine queued it
  message: string | null
  subject: string | null
}

export interface NextTouchInput {
  // Drip campaign state — lives on the lead's intake row.
  dripCampaignType: string | null | undefined
  dripTouchNumber: number | null | undefined
  lastDripSentAt: string | null | undefined
  createdAt: string
  hasPhone: boolean
  // Lead lifecycle — drips are suppressed for active/dead/DNC/junk.
  status: string
  isDnc?: boolean | null
  isJunk?: boolean | null
  // Follow-up reminder.
  recommendedFollowupDate?: string | null
  followupReason?: string | null
  // A live drip_queue row, if one is waiting on the cluster.
  queuedDrip?: QueuedDrip | null
  // Evaluation time — defaults to now(). Pass explicitly in tests.
  now?: Date
}

const HOUR_MS = 3600_000
const DAY_MS = 86_400_000
const STOP_STATUSES = DRIP_STOP_STATUSES as readonly string[]

function startOfDay(d: Date): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

// Parse a touch's `due` into a comparable Date. Calls carry a bare date
// and are anchored at local midnight; drips carry a full instant.
function dueDate(touch: NextTouch): Date {
  return touch.kind === "call"
    ? new Date(`${touch.due}T00:00:00`)
    : new Date(touch.due)
}

// Millisecond sort key — lets callers order calls and drips on one axis.
export function touchSortKey(touch: NextTouch): number {
  return dueDate(touch).getTime()
}

// Bucket a touch into overdue / today / soon (this week) / future. Calls
// are compared as calendar days; drips as instants (a drip due earlier
// today still counts as "today"). MUST run with the consumer's wall clock
// — pass `now` from the browser for display bucketing.
export function classifyUrgency(touch: NextTouch, now: Date = new Date()): NextTouchUrgency {
  const todayStart = startOfDay(now)
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS)
  const weekOut = new Date(todayStart.getTime() + 7 * DAY_MS)
  const due = dueDate(touch)
  if (due < todayStart) return "overdue"
  if (due < tomorrowStart) return "today"
  if (due < weekOut) return "soon"
  return "future"
}

// Short relative label for the touch's timing, e.g. "in 1d 4h", "due now",
// "ready to send", "3d overdue", "May 22".
export function describeTouchWhen(touch: NextTouch, now: Date = new Date()): string {
  if (touch.kind === "drip") {
    if (touch.isQueued) {
      const lateDays = Math.floor((now.getTime() - new Date(touch.due).getTime()) / DAY_MS)
      return lateDays >= 1 ? `ready to send · ${lateDays}d late` : "ready to send"
    }
    const ms = new Date(touch.due).getTime() - now.getTime()
    if (ms <= 0) return "due now"
    const hours = Math.floor(ms / HOUR_MS)
    if (hours < 24) return `in ${hours}h`
    const days = Math.floor(hours / 24)
    const remH = hours - days * 24
    return remH > 0 ? `in ${days}d ${remH}h` : `in ${days}d`
  }
  // call — calendar-day relative
  const diffDays = Math.round(
    (startOfDay(new Date(`${touch.due}T00:00:00`)).getTime() - startOfDay(now).getTime()) / DAY_MS
  )
  if (diffDays < -1) return `${-diffDays}d overdue`
  if (diffDays === -1) return "yesterday"
  if (diffDays === 0) return "today"
  if (diffDays === 1) return "tomorrow"
  if (diffDays < 7) return `in ${diffDays}d`
  return new Date(`${touch.due}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })
}

// Resolve the drip side of a contact: a live queued row if one exists,
// otherwise a cadence forecast. Returns null when no drip is pending or
// the lead is blocked from drip outreach.
function resolveDripTouch(input: NextTouchInput): NextTouch | null {
  // A real queued row beats the forecast — it is actionable right now, so
  // it is "due" as of the moment the engine queued it.
  if (input.queuedDrip) {
    const q = input.queuedDrip
    return {
      kind: "drip",
      due: q.createdAt,
      reason: `Drip touch #${q.touchNumber}`,
      channel: q.channel,
      touchNumber: q.touchNumber,
      campaignType: q.campaignType,
      isQueued: true,
      queueId: q.id,
      message: q.message,
      subject: q.subject,
    }
  }

  // Forecast path — mirrors the drip engine's eligibility math so the UI
  // hint matches what the engine will actually do.
  if (STOP_STATUSES.includes(input.status)) return null
  if (input.isDnc || input.isJunk) return null
  if (!input.dripCampaignType) return null
  const campaign = getCampaign(input.dripCampaignType)
  if (!campaign) return null
  const next = getNextTouch(campaign, input.dripTouchNumber ?? 0)
  if (!next) return null // cadence exhausted

  // Engine base time: last drip sent if present, else lead creation +
  // campaign entry delay (the first-touch grace period).
  const baseMs = input.lastDripSentAt
    ? new Date(input.lastDripSentAt).getTime()
    : new Date(input.createdAt).getTime() + campaign.entryDelayHours * HOUR_MS
  const due = new Date(baseMs + next.delayHours * HOUR_MS).toISOString()

  return {
    kind: "drip",
    due,
    reason: `Drip touch #${next.touchNumber}`,
    channel: effectiveChannelForTouch(campaign, next.touchNumber, input.hasPhone),
    touchNumber: next.touchNumber,
    campaignType: campaign.type,
    isQueued: false,
    queueId: null,
    message: null,
    subject: null,
  }
}

// Resolve the follow-up call side of a contact.
function resolveCallTouch(input: NextTouchInput): NextTouch | null {
  const date = input.recommendedFollowupDate
  if (!date) return null
  return {
    kind: "call",
    due: date, // bare YYYY-MM-DD — bucketed in the consumer's TZ
    reason: input.followupReason ?? null,
    channel: null,
    touchNumber: null,
    campaignType: null,
    isQueued: false,
    queueId: null,
    message: null,
    subject: null,
  }
}

// The core resolver. Given a contact's drip + follow-up state, returns the
// soonest touch as `primary` and the other-kind touch (if any) as
// `secondary`.
export function resolveNextTouch(input: NextTouchInput): NextTouchSummary {
  const candidates: NextTouch[] = []
  const drip = resolveDripTouch(input)
  if (drip) candidates.push(drip)
  const call = resolveCallTouch(input)
  if (call) candidates.push(call)

  if (candidates.length === 0) return { primary: null, secondary: null }
  candidates.sort((a, b) => touchSortKey(a) - touchSortKey(b))
  return { primary: candidates[0], secondary: candidates[1] ?? null }
}
