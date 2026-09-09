import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { completeText, extractJsonObject, hasLlmKey, HAIKU } from "@/lib/llm"

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  if (!hasLlmKey()) return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 })

  let notes = ""
  try {
    const body = await request.json()
    notes = typeof body.notes === "string" ? body.notes.trim() : ""
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (!notes) return NextResponse.json({ cleared: true })

  const today = new Date().toISOString().slice(0, 10)
  const prompt = `Today is ${today}. A real estate agent wrote the following notes about a lead:

"${notes}"

Extract a recommended follow-up date and reason if the notes mention a specific timeframe or cadence (e.g. "every 6 months", "call next week", "follow up in 3 months", "check back in spring").

Respond with ONLY a JSON object — no markdown, no explanation:
{ "date": "YYYY-MM-DD", "reason": "short reason phrase" }

If no follow-up timeframe is mentioned, respond with:
{ "date": null, "reason": null }`

  let content = ""
  try {
    const out = await completeText({ model: HAIKU, prompt, maxTokens: 200, tag: "[extract-followup]" })
    content = extractJsonObject(out.text)
  } catch (e) {
    return NextResponse.json({ error: `model call failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 })
  }

  let date: string | null = null
  let reason: string | null = null
  try {
    const parsed = JSON.parse(content) as { date?: string | null; reason?: string | null }
    date = parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null
    reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : null
  } catch {
    return NextResponse.json({ error: "model parse error", raw: content }, { status: 502 })
  }

  if (!date) return NextResponse.json({ date: null, reason: null })

  const sb = getLeadsClient()
  const { error } = await sb.from("leads").update({
    recommended_followup_date: date,
    followup_reason: reason,
  }).eq("id", id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ date, reason })
}
