import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { buildLeadContext, proposePlan, draftReply, type Plan } from "@/lib/reply"

// Reply Planner Phase 4 — "Not right" on a queued drip. Redrafts the pending
// drip_queue row through the shared engine (full thread + playbook + Ryan's
// why), records the redraft chained to the engine's original, and replaces
// the queued text in place. No sidecar hop.
// Body: { why?: string }. Returns { item } (the updated drip_queue row).
export const dynamic = "force-dynamic"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 })
  let why: string | null = null
  try {
    const body = await request.json()
    if (body && typeof body.why === "string" && body.why.trim()) why = body.why.trim()
  } catch { /* optional */ }

  const sb = getLeadsClient()
  const { data: q, error } = await sb.from("drip_queue").select("id, lead_id, channel, message, subject, status, touch_number, campaign_type").eq("id", id).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!q) return NextResponse.json({ error: "row not found" }, { status: 404 })
  if (q.status !== "pending") return NextResponse.json({ error: "row is not pending" }, { status: 409 })

  try {
    const ctx = await buildLeadContext(q.lead_id)
    if (!ctx) return NextResponse.json({ error: "lead not found" }, { status: 404 })
    let plan: Plan | null = ctx.moment
      ? { moment: ctx.moment, temperature: ctx.temperature, next_action: "drip", reason: `drip touch #${q.touch_number} (${q.campaign_type})`, source: "ai" }
      : await proposePlan(ctx)
    if (!plan) plan = { moment: "silence_breaker", temperature: ctx.temperature, next_action: "drip", reason: "", source: "ai" }
    plan = { ...plan, next_action: "drip" }

    const { data: prior } = await sb.from("reply_drafts").select("id").eq("drip_queue_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle()
    const result = await draftReply({
      ctx, plan,
      channel: q.channel === "email" ? "email" : "sms",
      surface: "drip",
      why,
      parentDraftId: prior?.id ?? null,
      previousDraft: { subject: q.subject, body: q.message },
      dripQueueId: id,
    })
    if (!result) return NextResponse.json({ error: "draft unavailable" }, { status: 502 })

    const update: Record<string, unknown> = { message: result.body }
    if (q.channel === "email" && result.subject) update.subject = result.subject
    const { data: item, error: upErr } = await sb.from("drip_queue").update(update).eq("id", id).eq("status", "pending").select().maybeSingle()
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
    if (!item) return NextResponse.json({ error: "row no longer pending" }, { status: 409 })
    return NextResponse.json({ item, draftId: result.draftId, critic: result.critic, plan: result.plan })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
