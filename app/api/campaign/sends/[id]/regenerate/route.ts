import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { loadRegenContext, regenerateSend, saveCopyRule } from "@/lib/campaignRegenerate"

// Regenerate one un-sent Phase B draft (Ryan 2026-08-24: cheaper than editing
// by hand, and a rejection is itself a voice-learning signal). Body (optional):
//   { note?: string, saveAsRule?: boolean }
// note = why this draft was rejected (goes into the prompt for the reroll);
// saveAsRule = also store it as a standing copy rule for every future compose.

export const maxDuration = 60

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
  let body: { note?: string; saveAsRule?: boolean } = {}
  try { body = await req.json() } catch { /* body optional */ }
  const note = typeof body.note === "string" ? body.note.trim() : ""
  try {
    const sb = getLeadsClient()
    let ruleId: string | null = null
    if (body.saveAsRule && note) ruleId = await saveCopyRule(sb, note)
    const regen = await loadRegenContext(sb)
    const out = await regenerateSend(sb, id, note, regen)
    if (!out.ok) return NextResponse.json({ error: out.error, ruleId }, { status: out.status })
    return NextResponse.json({ ok: true, subject: out.subject, body: out.body, ruleId })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
