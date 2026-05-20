import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, clusterKeyOrId } from "@/lib/leads"
import {
  resolveNextTouch,
  touchSortKey,
  type NextTouch,
  type NextTouchInput,
  type QueuedDrip,
  type NextTouchChannel,
} from "@/lib/next-touch"

// Merged Follow Ups worklist. One row per contact who has any scheduled
// touch — a follow-up call, a drip, or both — resolved through the shared
// lib/next-touch resolver so this list and the lead card's "Next touch"
// pill can never disagree.
//
// Returns:
//   rows        — every contact with a next touch (primary + optional
//                 secondary). Sorted soonest-first; the client re-buckets
//                 into Overdue / Today / This week / Upcoming.
//   failed      — drip_queue rows the engine couldn't send (collapsed UI)
//   recentSent  — drips sent in the last 7 days (collapsed audit log)
//
// force-dynamic: this route reads no per-request input, so Next.js would
// otherwise infer it static and Vercel would edge-cache stale buckets.
export const dynamic = "force-dynamic"

const SENT_HISTORY_DAYS = 7
const FAILED_HISTORY_DAYS = 14

interface CandidateLead {
  id: string
  caller_phone: string | null
  email: string | null
  gmail_thread_id: string | null
  source: string | null
  source_type: string | null
  name: string | null
  status: string | null
  created_at: string
  property_address: string | null
  temperature: string | null
  drip_campaign_type: string | null
  drip_touch_number: number | null
  last_drip_sent_at: string | null
  is_dnc: boolean | null
  is_junk: boolean | null
  recommended_followup_date: string | null
  followup_reason: string | null
  lead_type: string | null
  twilio_number: string | null
  notes: string | null
}

const LEAD_COLS =
  "id, caller_phone, email, gmail_thread_id, source, source_type, name, status, created_at, " +
  "property_address, temperature, drip_campaign_type, drip_touch_number, last_drip_sent_at, " +
  "is_dnc, is_junk, recommended_followup_date, followup_reason, lead_type, twilio_number, notes"

interface ContactRow {
  clusterKey: string
  // Representative lead id + phone — the client opens the lead-card popup
  // from these (phone deeplink when present, id otherwise).
  leadId: string
  // Lead id carrying the drip campaign — Prepare / forecast-skip act on it.
  dripLeadId: string | null
  // Lead id carrying the follow-up date — call snooze / Done patch it.
  followupLeadId: string | null
  name: string | null
  phone: string | null
  email: string | null
  source: string | null
  propertyAddress: string | null
  status: string
  temperature: "hot" | "warm" | "cold" | null
  // Ryan's notes — shown as guidance in the manual-compose popup.
  notes: string | null
  // Id of an inbound email row in the cluster, if any — lets a manual email
  // thread the existing Gmail conversation instead of starting fresh.
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

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString()
}

function resolveName(
  lead: CandidateLead | undefined,
  nameByPhone: Map<string, string>,
  nameByEmail: Map<string, string>
): string | null {
  if (!lead) return null
  if (lead.name && lead.name !== "Anonymous") return lead.name
  if (lead.caller_phone && nameByPhone.has(lead.caller_phone)) return nameByPhone.get(lead.caller_phone) ?? null
  if (lead.email && nameByEmail.has(lead.email)) return nameByEmail.get(lead.email) ?? null
  return null
}

const ISO_MAX = "9999-12-31"

// Among the stamped leads in a cluster, pick the one whose drip forecast
// fires soonest — that's the touch the engine will act on next.
function pickDripLead(stamped: CandidateLead[]): CandidateLead | null {
  let best: { lead: CandidateLead; key: number } | null = null
  for (const l of stamped) {
    const r = resolveNextTouch({
      dripCampaignType: l.drip_campaign_type,
      dripTouchNumber: l.drip_touch_number,
      lastDripSentAt: l.last_drip_sent_at,
      createdAt: l.created_at,
      hasPhone: Boolean(l.caller_phone && l.caller_phone !== "Anonymous"),
      status: l.status ?? "new",
      isDnc: l.is_dnc,
      isJunk: l.is_junk,
    })
    if (r.primary && r.primary.kind === "drip") {
      const k = touchSortKey(r.primary)
      if (!best || k < best.key) best = { lead: l, key: k }
    }
  }
  return best?.lead ?? null
}

export async function GET(_request: NextRequest) {
  try {
    const sb = getLeadsClient()
    const now = new Date()
    const sentCutoff = hoursAgo(SENT_HISTORY_DAYS * 24)
    const failedCutoff = hoursAgo(FAILED_HISTORY_DAYS * 24)

    // 1. drip_queue rows: live (pending/approved) + recent sent + recent
    //    failed. Live rows feed the worklist; sent/failed feed collapsed
    //    sections.
    const { data: queueRows, error: qErr } = await sb
      .from("drip_queue")
      .select("*")
      .or(
        `status.eq.pending,status.eq.approved,` +
          `and(status.eq.sent,sent_at.gte.${sentCutoff}),` +
          `and(status.eq.failed,created_at.gte.${failedCutoff})`
      )
      .order("created_at", { ascending: false })
      .limit(500)
    if (qErr) {
      console.error("[follow-ups:GET] queue query failed:", qErr)
      return NextResponse.json({ error: qErr.message }, { status: 500 })
    }

    // 2. Every lead with a drip stamp OR a follow-up date — the worklist
    //    candidates. Plus any leads referenced by queue rows that fell
    //    outside that set (stamp cleared on dead/dnc but a row lingers).
    const { data: candRows, error: cErr } = await sb
      .from("leads")
      .select(LEAD_COLS)
      .or("drip_campaign_type.not.is.null,recommended_followup_date.not.is.null")
      .limit(3000)
    if (cErr) {
      console.error("[follow-ups:GET] candidates query failed:", cErr)
      return NextResponse.json({ error: cErr.message }, { status: 500 })
    }
    const candidates = (candRows ?? []) as unknown as CandidateLead[]
    const candIds = new Set(candidates.map((l) => l.id))

    const queueLeadIds = Array.from(new Set((queueRows ?? []).map((r) => r.lead_id as string)))
    const missingIds = queueLeadIds.filter((id) => !candIds.has(id))
    if (missingIds.length > 0) {
      const { data: extras } = await sb.from("leads").select(LEAD_COLS).in("id", missingIds)
      for (const e of (extras ?? []) as unknown as CandidateLead[]) candidates.push(e)
    }

    // 3. Name fallback maps — a follow-up/drip row often has name=null while
    //    a sibling row on the same phone/email carries the real name.
    const { data: nameRows } = await sb
      .from("leads")
      .select("caller_phone, email, name")
      .not("name", "is", null)
      .limit(5000)
    const nameByPhone = new Map<string, string>()
    const nameByEmail = new Map<string, string>()
    for (const r of (nameRows ?? []) as { caller_phone: string | null; email: string | null; name: string | null }[]) {
      if (r.name && r.name !== "Anonymous") {
        if (r.caller_phone && !nameByPhone.has(r.caller_phone)) nameByPhone.set(r.caller_phone, r.name)
        if (r.email && !nameByEmail.has(r.email)) nameByEmail.set(r.email, r.name)
      }
    }

    // 4. Cluster the candidate leads. One worklist row per contact.
    const leadById = new Map<string, CandidateLead>(candidates.map((l) => [l.id, l]))
    const clusters = new Map<string, CandidateLead[]>()
    for (const l of candidates) {
      const key = clusterKeyOrId({
        caller_phone: l.caller_phone,
        email: l.email,
        gmail_thread_id: l.gmail_thread_id,
        id: l.id,
      })
      if (!clusters.has(key)) clusters.set(key, [])
      clusters.get(key)!.push(l)
    }

    // Live (pending/approved) queue rows grouped by cluster — the resolver
    // prefers a real queued row over a forecast.
    const liveQueueByCluster = new Map<string, Record<string, unknown>[]>()
    for (const row of (queueRows ?? []) as Record<string, unknown>[]) {
      const status = row.status as string
      if (status !== "pending" && status !== "approved") continue
      const lead = leadById.get(row.lead_id as string)
      if (!lead) continue
      // Snoozed rows are pushed out of view until the timestamp passes.
      const snoozedUntil = (row.snoozed_until as string | null) ?? null
      if (snoozedUntil && new Date(snoozedUntil).getTime() > now.getTime()) continue
      const key = clusterKeyOrId({
        caller_phone: lead.caller_phone,
        email: lead.email,
        gmail_thread_id: lead.gmail_thread_id,
        id: lead.id,
      })
      if (!liveQueueByCluster.has(key)) liveQueueByCluster.set(key, [])
      liveQueueByCluster.get(key)!.push(row)
    }

    // 5. Resolve each cluster to a worklist row.
    const rows: ContactRow[] = []
    clusters.forEach((leads, key) => {
      // Skip explicitly killed contacts — DNC, junk, or a dead most-recent
      // row. These were intentionally removed from outreach.
      if (leads.some((l) => l.is_dnc || l.is_junk)) return
      const byRecent = [...leads].sort((a, b) => b.created_at.localeCompare(a.created_at))
      const rep = byRecent[0]
      if ((rep.status ?? "").toLowerCase() === "dead") return

      const stamped = leads.filter((l) => l.drip_campaign_type)
      const dripLead = pickDripLead(stamped)

      // Oldest live queue row on the cluster — the one the engine queued
      // first and that is most overdue for a send.
      const liveQueue = (liveQueueByCluster.get(key) ?? []).sort((a, b) =>
        (a.created_at as string).localeCompare(b.created_at as string)
      )
      const qRow = liveQueue[0]
      const queuedDrip: QueuedDrip | null = qRow
        ? {
            id: qRow.id as string,
            touchNumber: qRow.touch_number as number,
            channel: qRow.channel as NextTouchChannel,
            campaignType: qRow.campaign_type as string,
            createdAt: qRow.created_at as string,
            message: (qRow.message as string | null) ?? null,
            subject: (qRow.subject as string | null) ?? null,
          }
        : null

      // Soonest follow-up date across the cluster.
      const fuLead = leads
        .filter((l) => l.recommended_followup_date)
        .sort((a, b) =>
          (a.recommended_followup_date ?? ISO_MAX).localeCompare(b.recommended_followup_date ?? ISO_MAX)
        )[0]

      const hasPhone = leads.some((l) => l.caller_phone && l.caller_phone !== "Anonymous")
      const input: NextTouchInput = {
        dripCampaignType: dripLead?.drip_campaign_type,
        dripTouchNumber: dripLead?.drip_touch_number,
        lastDripSentAt: dripLead?.last_drip_sent_at,
        createdAt: dripLead?.created_at ?? rep.created_at,
        hasPhone,
        status: rep.status ?? "new",
        isDnc: rep.is_dnc,
        isJunk: rep.is_junk,
        recommendedFollowupDate: fuLead?.recommended_followup_date,
        followupReason: fuLead?.followup_reason,
        queuedDrip,
        now,
      }
      const summary = resolveNextTouch(input)
      if (!summary.primary) return

      const phone =
        leads.find((l) => l.caller_phone && l.caller_phone !== "Anonymous")?.caller_phone ?? null
      const email = leads.find((l) => l.email)?.email ?? null
      const property = leads.find((l) => l.property_address)?.property_address ?? null
      const temp = byRecent.find((l) => l.temperature)?.temperature ?? null
      // Newest inbound email row in the cluster → threads a manual reply.
      const emailReplyLead = byRecent.find((l) => l.lead_type === "email" && l.twilio_number)

      rows.push({
        clusterKey: key,
        leadId: rep.id,
        dripLeadId: qRow ? (qRow.lead_id as string) : (dripLead?.id ?? null),
        followupLeadId: fuLead?.id ?? null,
        name:
          resolveName(
            leads.find((l) => l.name && l.name !== "Anonymous") ?? rep,
            nameByPhone,
            nameByEmail
          ),
        phone,
        email,
        source: leads.find((l) => l.source)?.source ?? null,
        propertyAddress: property,
        status: rep.status ?? "new",
        temperature: temp === "hot" || temp === "warm" || temp === "cold" ? temp : null,
        notes: byRecent.find((l) => l.notes && l.notes.trim())?.notes ?? null,
        emailReplyLeadId: emailReplyLead?.id ?? null,
        primary: summary.primary,
        secondary: summary.secondary,
      })
    })

    // Soonest-first. The client re-sorts within buckets (calls before
    // drips, by temperature) per the Follow Ups tab spec.
    rows.sort((a, b) => touchSortKey(a.primary) - touchSortKey(b.primary))

    // 6. Collapsed sections — failed + recently sent drips.
    const failed: DripCard[] = []
    const recentSent: DripCard[] = []
    for (const row of (queueRows ?? []) as Record<string, unknown>[]) {
      const status = row.status as string
      if (status !== "failed" && status !== "sent") continue
      const lead = leadById.get(row.lead_id as string)
      const card: DripCard = {
        id: row.id as string,
        lead_id: row.lead_id as string,
        touch_number: row.touch_number as number,
        channel: row.channel as string,
        message: row.message as string,
        subject: (row.subject as string | null) ?? null,
        status,
        created_at: row.created_at as string,
        sent_at: (row.sent_at as string | null) ?? null,
        error: (row.error as string | null) ?? null,
        name: resolveName(lead, nameByPhone, nameByEmail),
        caller_phone: lead?.caller_phone ?? null,
        email: lead?.email ?? null,
      }
      if (status === "failed") failed.push(card)
      else recentSent.push(card)
    }
    failed.sort((a, b) => b.created_at.localeCompare(a.created_at))
    recentSent.sort((a, b) => (b.sent_at || b.created_at).localeCompare(a.sent_at || a.created_at))

    return NextResponse.json({
      rows,
      failed,
      recentSent,
      meta: {
        rowCount: rows.length,
        sentHistoryDays: SENT_HISTORY_DAYS,
        failedHistoryDays: FAILED_HISTORY_DAYS,
        generatedAt: now.toISOString(),
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[follow-ups:GET] error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
