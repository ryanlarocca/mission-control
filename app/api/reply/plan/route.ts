import { NextRequest, NextResponse } from "next/server"
import { buildLeadContext, buildRelationshipContext, proposePlan, stampLeadMoment } from "@/lib/reply"

// Reply Planner — propose the plan chips for a contact.
// Body: { leadId } | { relationshipId }. Returns { plan, context: {moment, temperature, ...} }.
// Stamps leads.moment on the cluster so the worklist and drips can read it.
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  let body: { leadId?: unknown; relationshipId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  try {
    if (typeof body.leadId === "string" && body.leadId) {
      const ctx = await buildLeadContext(body.leadId)
      if (!ctx) return NextResponse.json({ error: "lead not found" }, { status: 404 })
      const plan = await proposePlan(ctx)
      if (!plan) return NextResponse.json({ error: "plan unavailable" }, { status: 502 })
      await stampLeadMoment(ctx.clusterIds, plan.moment)
      return NextResponse.json({ plan, inboundChannel: ctx.inboundChannel, threadCount: ctx.thread.length })
    }
    if (typeof body.relationshipId === "string" && body.relationshipId) {
      const ctx = await buildRelationshipContext(body.relationshipId)
      if (!ctx) return NextResponse.json({ error: "relationship not found" }, { status: 404 })
      const plan = await proposePlan(ctx)
      if (!plan) return NextResponse.json({ error: "plan unavailable" }, { status: 502 })
      return NextResponse.json({ plan, threadCount: ctx.thread.length })
    }
    return NextResponse.json({ error: "leadId or relationshipId required" }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
