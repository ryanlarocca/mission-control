import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { resolveLeadCallerId } from "@/lib/leadCall"
import { gatherLeadContext } from "@/lib/coach/context"
import { generateCallScript } from "@/lib/coach/script"

// Pre-call script for a lead (Sales Coach, 2026-11-02). The card calls this
// when Ryan taps Call (with the new call row's leadId, so the script is
// saved on that row and the post-call rater can see what he was shown) or
// taps Script before dialing (no leadId — generate only). Auth-gated by
// middleware like every /api route.
//
// Opus takes a while, so the function gets the long budget; the card shows
// a spinner and the ring-first leg covers most of the wait.
export const maxDuration = 120

function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith("+") && /^\+\d{10,15}$/.test(trimmed)) return trimmed
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}

export async function POST(request: NextRequest) {
  let body: { phone?: unknown; leadId?: unknown; callerId?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const phone = typeof body.phone === "string" ? normalizeE164(body.phone) : null
  if (!phone) return NextResponse.json({ error: "phone is required" }, { status: 400 })
  const leadId = typeof body.leadId === "string" && body.leadId ? body.leadId : null

  const sb = getLeadsClient()
  let callerId = typeof body.callerId === "string" && body.callerId.startsWith("+") ? body.callerId : null
  if (!callerId) {
    try {
      callerId = (await resolveLeadCallerId(sb, phone)).callerId
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
  }

  const ctx = await gatherLeadContext(sb, phone)
  const script = await generateCallScript(ctx, callerId)
  if (!script) return NextResponse.json({ error: "Script generation failed — try again" }, { status: 502 })

  if (leadId) {
    const { error } = await sb.from("leads").update({ coach_script: script }).eq("id", leadId)
    if (error) console.error(`[coach/script] coach_script write failed (${leadId}): ${error.message}`)
  }
  return NextResponse.json({ script })
}
