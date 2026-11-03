import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { resolveLeadCallerId } from "@/lib/leadCall"
import { gatherLeadContext, gatherRyanVoiceSamples } from "@/lib/coach/context"
import { generateCallScript, type CallScript } from "@/lib/coach/script"
import { formatPhone } from "@/lib/utils"

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
  let body: { phone?: unknown; leadId?: unknown; callerId?: unknown; force?: unknown } = {}
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

  const force = body && typeof body === "object" && (body as { force?: unknown }).force === true
  const ctx = await gatherLeadContext(sb, phone)

  // Reuse a fresh script (Ryan, 2026-11-02: "it took until 5 or 6 seconds
  // into the call for that to populate"). Fresh = under a day old, written
  // for the same caller ID, and nothing new from them since. The Follow Ups
  // tab prefetches scripts for the call-due cards, so the tap hits this.
  const cached = ctx.lastScript as CallScript | null
  const freshMs = 24 * 60 * 60 * 1000
  const numberToSay = formatPhone(callerId) ?? callerId
  const fresh = !force && cached && ctx.lastScriptAt
    && Date.now() - new Date(ctx.lastScriptAt).getTime() < freshMs
    && cached.numberToSay === numberToSay
    && (!ctx.lastFromThem || ctx.lastFromThem <= ctx.lastScriptAt.slice(0, 10))
  let script: CallScript | null = fresh ? cached : null
  let reused = !!script
  if (!script) {
    const voice = await gatherRyanVoiceSamples(sb)
    script = await generateCallScript(ctx, callerId, voice)
    if (!script) return NextResponse.json({ error: "Script generation failed — try again" }, { status: 502 })
    reused = false
  }

  // Save on the call row when there is one (the rater reads it there);
  // otherwise cache it on the newest row of the cluster for the next tap.
  const target = leadId ?? (reused ? null : ctx.newestId)
  if (target) {
    const { error } = await sb.from("leads").update({ coach_script: script }).eq("id", target)
    if (error) console.error(`[coach/script] coach_script write failed (${target}): ${error.message}`)
  }
  return NextResponse.json({ script, reused })
}
