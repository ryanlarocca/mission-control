import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import {
  buildLeadContext, buildRelationshipContext, coercePlan, coachDraft,
  type CoachTurn, type DraftChannel,
} from "@/lib/reply"

// Coach mode (briefs/BRIEF_COACHED_DRAFT_2026-10-15.md §D) — draft from
// Ryan's dictated gist. Same auth as /api/reply/draft (the session cookie
// via middleware).
// Body: {
//   leadId | relationshipId,
//   channel: "email" | "sms" | "imessage",
//   surface: "leads_card" | "followups" | "relationships" | "telegram" | "drip",
//   gist: string,
//   turns?: { gist, body }[],          // prior coach turns when refining
//   plan?: { moment, temperature?, next_action, reason? },   // chips as shown; omitted → proposed fresh
//   parentDraftId?: string,            // the previous coach draft on a refinement
//   dripQueueId?: string,              // Follow Ups drip block: write the result into the pending drip_queue row
// }
// Returns { read, subject, body, draftId, plan, critic, ... } (+ item for a drip).
export const dynamic = "force-dynamic"
// Opus with thinking over a long thread, then the Sonnet critic.
export const maxDuration = 120

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  let body: {
    leadId?: unknown; relationshipId?: unknown; channel?: unknown; surface?: unknown; gist?: unknown
    turns?: unknown; parentDraftId?: unknown; dripQueueId?: unknown
    plan?: { moment?: unknown; temperature?: unknown; next_action?: unknown; reason?: unknown; familiarity?: unknown; intent?: unknown }
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const gist = typeof body.gist === "string" ? body.gist.trim() : ""
  if (!gist) return NextResponse.json({ error: "gist required" }, { status: 400 })
  const channel: DraftChannel = body.channel === "email" ? "email" : body.channel === "imessage" ? "imessage" : "sms"
  const surfaces = ["leads_card", "followups", "relationships", "telegram", "drip"] as const
  const surface = surfaces.includes(body.surface as (typeof surfaces)[number]) ? (body.surface as (typeof surfaces)[number]) : "leads_card"
  const turns: CoachTurn[] = Array.isArray(body.turns)
    ? body.turns
        .filter((t): t is { gist: string; body: string } => !!t && typeof t === "object" && typeof (t as { gist?: unknown }).gist === "string" && typeof (t as { body?: unknown }).body === "string")
        .map((t) => ({ gist: t.gist, body: t.body }))
    : []
  const parentDraftId = typeof body.parentDraftId === "string" && body.parentDraftId.trim() ? body.parentDraftId.trim() : null
  const dripQueueId = typeof body.dripQueueId === "string" && UUID_RE.test(body.dripQueueId) ? body.dripQueueId : null

  try {
    const isLead = typeof body.leadId === "string" && !!body.leadId
    const ctx = isLead
      ? await buildLeadContext(body.leadId as string)
      : typeof body.relationshipId === "string" && body.relationshipId
        ? await buildRelationshipContext(body.relationshipId)
        : null
    if (!ctx) return NextResponse.json({ error: "contact not found" }, { status: 404 })

    // Drip block: the pending drip_queue row is what gets rewritten.
    let drip: { id: string; channel: string | null; subject: string | null; message: string | null } | null = null
    if (dripQueueId) {
      const sb = getLeadsClient()
      const { data: q, error } = await sb.from("drip_queue").select("id, lead_id, channel, message, subject, status").eq("id", dripQueueId).maybeSingle()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!q) return NextResponse.json({ error: "drip row not found" }, { status: 404 })
      if (q.status !== "pending") return NextResponse.json({ error: "drip row is not pending" }, { status: 409 })
      if (ctx.kind !== "lead" || !ctx.clusterIds.includes(q.lead_id)) {
        return NextResponse.json({ error: "drip row does not belong to this lead" }, { status: 400 })
      }
      drip = q
    }

    let plan = coercePlan(ctx, body.plan)
    if (drip && plan) plan = { ...plan, next_action: "drip" }

    const result = await coachDraft({
      ctx, channel: drip ? (drip.channel === "email" ? "email" : "sms") : channel,
      surface: drip ? "drip" : surface,
      gist, turns, plan, parentDraftId,
      dripQueueId: drip?.id ?? null,
    })
    if (!result) return NextResponse.json({ error: "coach unavailable" }, { status: 502 })

    if (drip) {
      const sb = getLeadsClient()
      const update: Record<string, unknown> = { message: result.body }
      if (drip.channel === "email" && result.subject) update.subject = result.subject
      const { data: item, error: upErr } = await sb.from("drip_queue").update(update).eq("id", drip.id).eq("status", "pending").select().maybeSingle()
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
      if (!item) return NextResponse.json({ error: "drip row no longer pending" }, { status: 409 })
      return NextResponse.json({ ...result, item })
    }
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
