import { NextRequest, NextResponse } from "next/server"
import {
  buildLeadContext, buildRelationshipContext, proposePlan, stampLeadMoment, draftReply,
  isLeadMoment, isRelationshipMoment, LEAD_NEXT_ACTIONS, RELATIONSHIP_NEXT_ACTIONS,
  type Plan, type DraftChannel,
} from "@/lib/reply"
import { VALID_TEMPERATURES } from "@/lib/leads"

// Reply Planner — draft from the plan.
// Body: {
//   leadId | relationshipId,
//   channel: "email" | "sms" | "imessage",
//   surface: "leads_card" | "followups" | "relationships" | "telegram",
//   plan?: { moment, temperature?, next_action, reason? }   // chips as shown; omitted → proposed fresh
//   why?: string, parentDraftId?: string, previousDraft?: { subject?, body }   // "Not right" redraft
// }
// Returns { draftId, subject, body, plan, critic }.
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  let body: {
    leadId?: unknown; relationshipId?: unknown; channel?: unknown; surface?: unknown
    plan?: { moment?: unknown; temperature?: unknown; next_action?: unknown; reason?: unknown; familiarity?: unknown; intent?: unknown }
    why?: unknown; parentDraftId?: unknown; previousDraft?: { subject?: unknown; body?: unknown }
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const channel: DraftChannel = body.channel === "email" ? "email" : body.channel === "imessage" ? "imessage" : "sms"
  const surfaces = ["leads_card", "followups", "relationships", "telegram"] as const
  const surface = surfaces.includes(body.surface as (typeof surfaces)[number]) ? (body.surface as (typeof surfaces)[number]) : "leads_card"

  try {
    const isLead = typeof body.leadId === "string" && !!body.leadId
    const ctx = isLead
      ? await buildLeadContext(body.leadId as string)
      : typeof body.relationshipId === "string" && body.relationshipId
        ? await buildRelationshipContext(body.relationshipId)
        : null
    if (!ctx) return NextResponse.json({ error: "contact not found" }, { status: 404 })

    // Plan: take Ryan's chips when supplied and valid, else propose.
    let plan: Plan | null = null
    const p = body.plan
    const momentOk = p && (ctx.kind === "lead" ? isLeadMoment(p.moment) : isRelationshipMoment(p.moment))
    if (p && momentOk) {
      const actions: readonly string[] = ctx.kind === "lead" ? LEAD_NEXT_ACTIONS : RELATIONSHIP_NEXT_ACTIONS
      plan = {
        moment: p.moment as string,
        temperature: ctx.kind === "lead" && typeof p.temperature === "string" && (VALID_TEMPERATURES as readonly string[]).includes(p.temperature) ? p.temperature : ctx.kind === "lead" ? ctx.temperature : null,
        next_action: typeof p.next_action === "string" && actions.includes(p.next_action) ? p.next_action : ctx.kind === "lead" ? "reply_only" : "send",
        reason: typeof p.reason === "string" ? p.reason : "",
        source: "ryan",
        ...(ctx.kind === "relationship" ? {
          familiarity: p.familiarity === "Knows" || p.familiarity === "Reintro" ? p.familiarity : ctx.everContacted ? "Knows" as const : "Reintro" as const,
          intent: p.intent === "CatchUp" || p.intent === "Deal" || p.intent === "Referral" || p.intent === "Portfolio" ? p.intent : null,
        } : {}),
      }
    } else {
      plan = await proposePlan(ctx)
      if (!plan) return NextResponse.json({ error: "plan unavailable" }, { status: 502 })
    }
    if (ctx.kind === "lead") await stampLeadMoment(ctx.clusterIds, plan.moment)

    const result = await draftReply({
      ctx, plan, channel, surface,
      why: typeof body.why === "string" ? body.why : null,
      parentDraftId: typeof body.parentDraftId === "string" ? body.parentDraftId : null,
      previousDraft: body.previousDraft && typeof body.previousDraft.body === "string"
        ? { subject: typeof body.previousDraft.subject === "string" ? body.previousDraft.subject : null, body: body.previousDraft.body }
        : null,
      notes: ctx.kind === "lead" ? ctx.notes : null,
    })
    if (!result) return NextResponse.json({ error: "draft unavailable" }, { status: 502 })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
