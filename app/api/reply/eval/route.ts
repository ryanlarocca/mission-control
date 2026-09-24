import { NextRequest, NextResponse } from "next/server"
import { readFileSync } from "node:fs"
import path from "node:path"
import { draftReply, proposePlan, loadPlaybook, type Plan, type ReplyContext, type ThreadItem, type DraftChannel } from "@/lib/reply"

// Reply Planner — run the engine over the graded eval set
// (briefs/tests/reply-eval-set.json) and return the new draft next to the
// reference for each item. Drafts are recorded with surface="eval" so they
// never feed exemplars or the scoreboard. Driven by scripts/reply-eval.mjs.
// Body: { ids?: string[], plan?: boolean (default true: propose the plan; false: use the item's moment) }
export const dynamic = "force-dynamic"
export const maxDuration = 300

interface EvalItem {
  id: string
  surface: "leads" | "relationships"
  moment: string
  channel: string | null
  contact: Record<string, unknown>
  note: string | null
  thread: { at: string; from: string; channel: string | null; text: string }[]
  inbound?: { at: string; text: string }
  generated_draft?: string
  reference_reply: string | null
  grade: string | null
  why: string | null
}

function ctxFromItem(it: EvalItem): ReplyContext {
  const thread: ThreadItem[] = it.thread.map((t) => ({
    at: t.at, channel: t.channel,
    from: t.from === "ryan(drip)" ? "ryan(drip)" : t.from === "ryan" ? "ryan" : "them",
    text: t.text,
  }))
  if (it.inbound && !thread.some((t) => t.text === it.inbound!.text)) {
    thread.push({ at: it.inbound.at, from: "them", channel: it.channel, text: it.inbound.text })
  }
  const c = it.contact as Record<string, string | null>
  if (it.surface === "relationships") {
    return {
      kind: "relationship", relationshipId: `eval:${it.id}`, name: c.name ?? null, phone: null,
      category: c.category ?? null, tier: c.tier ?? null, notes: c.notes ?? null, last_contacted_at: null, everContacted: true,
      thread, lastInbound: [...thread].reverse().find((t) => t.from === "them") ?? null,
    }
  }
  return {
    kind: "lead", leadId: `eval:${it.id}`, clusterIds: [], name: c.name ?? null, email: null, phone: null,
    property_address: c.property_address ?? null, property_details: null, status: null,
    temperature: c.temperature ?? null, moment: it.moment, source: c.source ?? null, campaign_label: null,
    ai_summary: null, notes: null, drip_campaign_type: null, recommended_followup_date: null, followup_reason: null,
    gmail_thread_id: null, inboundChannel: it.channel === "email" ? "email" : "sms",
    thread, lastInbound: [...thread].reverse().find((t) => t.from === "them") ?? null,
  }
}

export async function POST(request: NextRequest) {
  let body: { ids?: unknown; plan?: unknown } = {}
  try { body = await request.json() } catch { /* empty body ok */ }
  const wantIds = Array.isArray(body.ids) ? new Set(body.ids.filter((x): x is string => typeof x === "string")) : null
  const doPlan = body.plan !== false

  let items: EvalItem[]
  try {
    const set = JSON.parse(readFileSync(path.join(process.cwd(), "briefs", "tests", "reply-eval-set.json"), "utf8")) as { items: EvalItem[] }
    items = set.items.filter((it) => !wantIds || wantIds.has(it.id))
  } catch (e) {
    return NextResponse.json({ error: `eval set unreadable: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 })
  }

  const pb = loadPlaybook()
  const results: unknown[] = []
  for (const it of items) {
    const ctx = ctxFromItem(it)
    const channel: DraftChannel = it.channel === "email" ? "email" : "sms"
    let plan: Plan | null = null
    if (doPlan) plan = await proposePlan(ctx)
    if (!plan) plan = { moment: it.moment, temperature: (it.contact as { temperature?: string | null }).temperature ?? null, next_action: ctx.kind === "lead" ? "reply_only" : "send", reason: "", source: "ryan" }
    // Eval contexts carry synthetic ids, and the report file is the record.
    const draft = await draftReply({ ctx, plan, channel, surface: "eval", skipRecord: true, excludeExemplarReply: it.reference_reply })
    results.push({
      id: it.id, moment_expected: it.moment, plan, plan_matches: plan.moment === it.moment,
      reference: it.reference_reply, grade: it.grade, why: it.why,
      draft: draft ? { subject: draft.subject, body: draft.body, critic: draft.critic, exemplars: draft.exemplarCount } : null,
    })
  }
  return NextResponse.json({ playbook_version: pb.version, count: results.length, results })
}
