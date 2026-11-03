import { NextRequest, NextResponse } from "next/server"
import { OPUS } from "@/lib/llm"
import { buildLeadContext, planForDrip, draftReply } from "@/lib/reply"

// The drip engine's writer (scripts/drip-engine.js, on the Mac mini). Since
// 2026-11-03 a queued drip touch is written by the same Opus coach writer
// as the card, with no gist, plus the engine's rules for the touch (angle
// by touch number, responsiveness, banned phrases) as the touch brief.
// Public path, gated by the shared secret header like telegram-draft. Does
// not record: the engine inserts the drip_queue row, then the reply_drafts
// row with the fields returned here.
// Body: { leadId, touchNumber, campaignType, channel: "imessage" | "email", touchBrief? }
// Returns { body, subject, read, critic, plan, model, promptVersion, playbookVersion }.
export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function POST(request: NextRequest) {
  const secret = process.env.REPLY_INTERNAL_SECRET || process.env.MC_PASSWORD || ""
  if (!secret || request.headers.get("x-reply-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  let body: { leadId?: unknown; touchNumber?: unknown; campaignType?: unknown; channel?: unknown; touchBrief?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  const leadId = typeof body.leadId === "string" ? body.leadId : ""
  if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 })
  const touchNumber = typeof body.touchNumber === "number" ? body.touchNumber : null
  const campaignType = typeof body.campaignType === "string" ? body.campaignType : null
  const channel = body.channel === "email" ? "email" : "sms"
  const touchBrief = typeof body.touchBrief === "string" ? body.touchBrief.slice(0, 8000) : null

  try {
    const ctx = await buildLeadContext(leadId)
    if (!ctx) return NextResponse.json({ error: "lead not found" }, { status: 404 })
    const plan = await planForDrip(ctx, touchNumber, campaignType)
    const out = await draftReply({ ctx, plan, channel, surface: "drip", notes: ctx.notes, touchBrief, skipRecord: true })
    if (!out) return NextResponse.json({ error: "draft unavailable" }, { status: 502 })
    return NextResponse.json({
      body: out.body, subject: out.subject, read: out.read ?? null, critic: out.critic,
      // The brief rides on plan_json so a later "Not right" on this touch
      // redrafts under the same rules (app/api/drips/[id]/redraft).
      plan: { ...out.plan, touch_brief: touchBrief },
      model: OPUS, promptVersion: out.promptVersion, playbookVersion: out.playbookVersion,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
