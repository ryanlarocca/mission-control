import { NextRequest, NextResponse } from "next/server"
import { postPlannerDraft } from "@/lib/reply/telegram"

// Reply Planner Phase 5 — post the plan + draft for a lead to Telegram.
// Public path (intake webhooks call it server-to-server after the alert);
// gated by a shared secret header instead of the session cookie.
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const secret = process.env.REPLY_INTERNAL_SECRET || process.env.MC_PASSWORD || ""
  if (!secret || request.headers.get("x-reply-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  let leadId = ""
  let dryRun = false
  try {
    const body = await request.json()
    leadId = typeof body?.leadId === "string" ? body.leadId : ""
    dryRun = body?.dryRun === true
  } catch { /* fallthrough */ }
  if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 })
  try {
    const out = await postPlannerDraft(leadId, { dryRun })
    return NextResponse.json(out, { status: out.ok ? 200 : 502 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
