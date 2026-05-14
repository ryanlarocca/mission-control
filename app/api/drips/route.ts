import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import {
  getCampaign,
  getNextTouch,
  effectiveChannelForTouch,
  DRIP_STOP_STATUSES,
  type DripCampaignType,
} from "@/lib/drip-campaigns"

// Drips tab data source. Combines the drip_queue table (current state) with
// a per-lead forecast (what the engine will queue next based on cadence).
//
// Buckets:
//   late       — pending rows older than LATE_THRESHOLD_HOURS
//   due        — pending rows ≤ LATE_THRESHOLD_HOURS old
//   failed     — rows the engine couldn't send (last FAILED_HISTORY_DAYS)
//   comingUp   — (approved-not-sent) + per-lead forecast for the next 14 days
//   recentSent — sent rows in the last 7 days
//
// Each row is enriched with `name`, `caller_phone`, `email`, `source` from
// the leads cluster so the UI never has to re-fetch. Names fall through:
//   row's own name → any sibling row's name on same phone → null

const LATE_THRESHOLD_HOURS = 24
const SENT_HISTORY_DAYS = 7
const FAILED_HISTORY_DAYS = 14
const FORECAST_DAYS = 14
const STOP_STATUSES = new Set<string>(DRIP_STOP_STATUSES)

interface LeadLite {
  id: string
  caller_phone: string | null
  email: string | null
  source: string | null
  source_type: string | null
  name: string | null
  status: string | null
  created_at: string
  drip_campaign_type: string | null
  drip_touch_number: number | null
  last_drip_sent_at: string | null
  is_dnc: boolean | null
  is_junk: boolean | null
}

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
  // True when the touch is already due (the engine would queue it on its
  // next hourly pass). Only due-now rows get a working "Prepare" button —
  // the engine's processLead returns `not_due` for anything still in the
  // future, so Prepare on a future row would be a silent no-op.
  due_now: boolean
  name: string | null
  caller_phone: string | null
  email: string | null
  source: string | null
  // Count of sibling cluster rows we merged into this one. 0 = single row,
  // N>0 = there were N+1 stamped leads rows on this cluster; we kept the
  // soonest-due and dropped the rest from the display.
  merged_siblings?: number
}

type ComingUpItem = DripCard | ForecastItem

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3600 * 1000)
}

function daysAhead(d: number): Date {
  return new Date(Date.now() + d * 86400 * 1000)
}

// Resolve a display name for a lead row: prefer its own name, else fall
// through to any sibling row on the same phone/email that carries one.
function resolveName(
  lead: LeadLite | undefined,
  nameByPhone: Map<string, string>,
  nameByEmail: Map<string, string>
): string | null {
  if (!lead) return null
  if (lead.name) return lead.name
  if (lead.caller_phone && nameByPhone.has(lead.caller_phone)) return nameByPhone.get(lead.caller_phone) ?? null
  if (lead.email && nameByEmail.has(lead.email)) return nameByEmail.get(lead.email) ?? null
  return null
}

function buildCard(row: Record<string, unknown>, lead: LeadLite | undefined, nameByPhone: Map<string, string>, nameByEmail: Map<string, string>): DripCard {
  return {
    id: row.id as string,
    lead_id: row.lead_id as string,
    touch_number: row.touch_number as number,
    campaign_type: row.campaign_type as string,
    channel: row.channel as "imessage" | "email",
    message: row.message as string,
    subject: (row.subject as string | null) ?? null,
    status: row.status as DripCard["status"],
    created_at: row.created_at as string,
    approved_at: (row.approved_at as string | null) ?? null,
    sent_at: (row.sent_at as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    name: resolveName(lead, nameByPhone, nameByEmail),
    caller_phone: lead?.caller_phone ?? null,
    email: lead?.email ?? null,
    source: lead?.source ?? null,
  }
}

// Forecast: given a lead with a drip_campaign_type stamp, when will the
// engine queue its next touch? Returns null if no eligible next touch
// within the forecast window or if the lead is blocked.
function forecastNextTouch(lead: LeadLite, now: Date, horizon: Date): ForecastItem | null {
  if (!lead.drip_campaign_type) return null
  if (lead.is_dnc || lead.is_junk) return null
  if (STOP_STATUSES.has((lead.status || "").toLowerCase())) return null

  const campaign = getCampaign(lead.drip_campaign_type as DripCampaignType)
  if (!campaign) return null

  const next = getNextTouch(campaign, lead.drip_touch_number ?? 0)
  if (!next) return null // cadence exhausted

  // Engine base time: last drip sent if present, else lead creation +
  // campaign entry delay. Mirrors the engine's eligibility math.
  const baseMs = lead.last_drip_sent_at
    ? new Date(lead.last_drip_sent_at).getTime()
    : new Date(lead.created_at).getTime() + campaign.entryDelayHours * 3600 * 1000
  const dueMs = baseMs + next.delayHours * 3600 * 1000
  if (dueMs > horizon.getTime()) return null

  const channel = effectiveChannelForTouch(
    campaign,
    next.touchNumber,
    Boolean(lead.caller_phone)
  )

  // If the due time is already past now, show it as due-now in the
  // forecast bucket — the engine will pick it up on its next pass.
  return {
    kind: "forecast",
    lead_id: lead.id,
    touch_number: next.touchNumber,
    campaign_type: campaign.type,
    channel,
    due_at: new Date(Math.max(dueMs, now.getTime())).toISOString(),
    due_now: dueMs <= now.getTime(),
    name: lead.name,
    caller_phone: lead.caller_phone,
    email: lead.email,
    source: lead.source,
  }
}

export async function GET(_request: NextRequest) {
  try {
    const sb = getLeadsClient()
    const now = new Date()
    const lateCutoff = hoursAgo(LATE_THRESHOLD_HOURS).toISOString()
    const sentCutoff = hoursAgo(SENT_HISTORY_DAYS * 24).toISOString()
    const failedCutoff = hoursAgo(FAILED_HISTORY_DAYS * 24).toISOString()
    const horizon = daysAhead(FORECAST_DAYS)

    // 1. drip_queue rows we care about: pending + approved-not-sent +
    //    recent sent + recent failed.
    const { data: queueRows, error: qErr } = await sb
      .from("drip_queue")
      .select("*")
      .or(`status.eq.pending,status.eq.approved,and(status.eq.sent,sent_at.gte.${sentCutoff}),and(status.eq.failed,created_at.gte.${failedCutoff})`)
      .order("created_at", { ascending: false })
      .limit(500)
    if (qErr) {
      console.error("[drips:GET] queue query failed:", qErr)
      return NextResponse.json({ error: qErr.message }, { status: 500 })
    }

    // 2. leads referenced by those rows + every lead with a drip campaign
    //    stamped (forecast input). Single query covers both.
    const leadIdsInQueue = new Set((queueRows ?? []).map(r => r.lead_id as string))
    const { data: stampedLeads, error: lErr } = await sb
      .from("leads")
      .select("id, caller_phone, email, source, source_type, name, status, created_at, drip_campaign_type, drip_touch_number, last_drip_sent_at, is_dnc, is_junk")
      .not("drip_campaign_type", "is", null)
      .limit(2000)
    if (lErr) {
      console.error("[drips:GET] leads query failed:", lErr)
      return NextResponse.json({ error: lErr.message }, { status: 500 })
    }

    // Some queue rows may reference leads that lack a current drip stamp
    // (the stamp gets cleared on dead/dnc) — fetch those individually so
    // names resolve.
    const stampedIds = new Set((stampedLeads ?? []).map(l => l.id as string))
    const missingIds = Array.from(leadIdsInQueue).filter(id => !stampedIds.has(id))
    let extraLeads: LeadLite[] = []
    if (missingIds.length > 0) {
      const { data: extras } = await sb
        .from("leads")
        .select("id, caller_phone, email, source, source_type, name, status, created_at, drip_campaign_type, drip_touch_number, last_drip_sent_at, is_dnc, is_junk")
        .in("id", missingIds)
      extraLeads = (extras ?? []) as LeadLite[]
    }

    const allLeads: LeadLite[] = [...(stampedLeads ?? []) as LeadLite[], ...extraLeads]
    const leadById = new Map<string, LeadLite>(allLeads.map(l => [l.id, l]))

    // Pull every lead row to build phone/email → name fallbacks (sibling
    // rows in a cluster may carry the name the drip target row lacks).
    const { data: nameRows } = await sb
      .from("leads")
      .select("caller_phone, email, name")
      .not("name", "is", null)
      .limit(5000)
    const nameByPhone = new Map<string, string>()
    const nameByEmail = new Map<string, string>()
    for (const r of (nameRows ?? []) as { caller_phone: string | null; email: string | null; name: string | null }[]) {
      if (r.name && r.caller_phone && !nameByPhone.has(r.caller_phone)) nameByPhone.set(r.caller_phone, r.name)
      if (r.name && r.email && !nameByEmail.has(r.email)) nameByEmail.set(r.email, r.name)
    }

    // 3. Bucket the queue rows.
    const late: DripCard[] = []
    const due: DripCard[] = []
    const failed: DripCard[] = []
    const approvedNotSent: DripCard[] = []
    const recentSent: DripCard[] = []
    for (const row of (queueRows ?? []) as Record<string, unknown>[]) {
      const lead = leadById.get(row.lead_id as string)
      const card = buildCard(row, lead, nameByPhone, nameByEmail)
      if (card.status === "pending") {
        if (card.created_at < lateCutoff) late.push(card)
        else due.push(card)
      } else if (card.status === "approved") {
        approvedNotSent.push(card)
      } else if (card.status === "sent") {
        recentSent.push(card)
      } else if (card.status === "failed") {
        failed.push(card)
      }
    }

    // 4. Forecast: for every stamped lead WITHOUT a pending/approved row
    //    in the queue, predict the next touch within 14d.
    const leadsWithLiveQueue = new Set<string>()
    for (const c of [...late, ...due, ...approvedNotSent]) leadsWithLiveQueue.add(c.lead_id)

    const rawForecast: ForecastItem[] = []
    for (const lead of (stampedLeads ?? []) as LeadLite[]) {
      if (leadsWithLiveQueue.has(lead.id)) continue
      // Filter Anonymous voicemails — we can't iMessage to "Anonymous", and
      // surfacing them clutters the view without giving Ryan a way to act.
      if (lead.caller_phone === "Anonymous") continue
      const f = forecastNextTouch(lead, now, horizon)
      if (!f) continue
      f.name = resolveName(lead, nameByPhone, nameByEmail)
      rawForecast.push(f)
    }

    // Cluster dedupe: when several leads rows on the same phone/thread/email
    // all carry their own drip_campaign_type stamp (common — re-engagement,
    // outbound callback, Apply Drip re-tag), the engine processes each row
    // independently. Surface a single forecast per cluster — the soonest-
    // due one — with a merged_siblings count so it's obvious there are
    // duplicates underneath. (Real fix is making the engine cluster-aware;
    // tracking that separately.)
    const clusterKey = (item: { caller_phone: string | null; email: string | null; lead_id: string }): string =>
      item.caller_phone ? `phone:${item.caller_phone}` :
      item.email ? `email:${item.email.toLowerCase()}` :
      `id:${item.lead_id}`
    const byCluster = new Map<string, ForecastItem[]>()
    for (const f of rawForecast) {
      const key = clusterKey(f)
      if (!byCluster.has(key)) byCluster.set(key, [])
      byCluster.get(key)!.push(f)
    }
    const forecast: ForecastItem[] = []
    byCluster.forEach((items: ForecastItem[]) => {
      items.sort((a: ForecastItem, b: ForecastItem) => a.due_at.localeCompare(b.due_at))
      const head = items[0]
      head.merged_siblings = items.length - 1
      forecast.push(head)
    })

    // Sort buckets chronologically.
    late.sort((a, b) => a.created_at.localeCompare(b.created_at))   // oldest first (most overdue)
    due.sort((a, b) => a.created_at.localeCompare(b.created_at))    // oldest first
    // Coming up = approved-not-sent (will fire next engine pass) + forecast.
    // Sort approved by approval time; forecast by due_at; merge ascending.
    const sortKey = (item: ComingUpItem): string =>
      "kind" in item ? item.due_at : (item.approved_at || item.created_at)
    const comingUp: ComingUpItem[] = [
      ...(approvedNotSent as ComingUpItem[]),
      ...(forecast as ComingUpItem[]),
    ].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))

    recentSent.sort((a, b) => (b.sent_at || b.created_at).localeCompare(a.sent_at || a.created_at)) // newest first
    failed.sort((a, b) => b.created_at.localeCompare(a.created_at)) // newest first

    return NextResponse.json({
      late,
      due,
      failed,
      comingUp,
      recentSent,
      meta: {
        lateThresholdHours: LATE_THRESHOLD_HOURS,
        forecastDays: FORECAST_DAYS,
        sentHistoryDays: SENT_HISTORY_DAYS,
        failedHistoryDays: FAILED_HISTORY_DAYS,
        generatedAt: now.toISOString(),
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[drips:GET] error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
