import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Phase 7C — Part 7: on-demand draft generator. Click "Draft Text" or
// "Draft Email" on a lead card → AI returns a contextual draft. NOT
// sent — Ryan reviews/edits in the existing composer textarea, then
// hits Send.
//
// Body: { channel: "imessage" | "email" }
// Returns: { message: string, subject?: string }

const HAIKU_MODEL = "anthropic/claude-haiku-4-5"

interface ContextRow {
  created_at: string
  lead_type: string | null
  twilio_number: string | null
  message: string | null
}

function dirLabel(r: ContextRow): string {
  if (!r.twilio_number) {
    return r.lead_type?.startsWith("drip_") ? "ryan(drip)" : "ryan"
  }
  return "lead"
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  let body: { channel?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const channel = body.channel === "email" ? "email" : "imessage"

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: "OPENROUTER_API_KEY not set" }, { status: 500 })
  }

  try {
    const sb = getLeadsClient()
    const { data: anchor, error } = await sb
      .from("leads")
      .select("id, name, email, caller_phone, source, campaign_label, property_address, status, ai_summary")
      .eq("id", id)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!anchor) return NextResponse.json({ error: "lead not found" }, { status: 404 })

    let q = sb
      .from("leads")
      .select("created_at, lead_type, twilio_number, message")
      .order("created_at", { ascending: true })
      .limit(40)
    if (anchor.caller_phone) q = q.eq("caller_phone", anchor.caller_phone)
    else if (anchor.email) q = q.eq("email", anchor.email)
    else q = q.eq("id", anchor.id)
    const { data: events } = await q.returns<ContextRow[]>()

    const transcript = (events || [])
      .filter(r => (r.message || "").trim().length > 0)
      .slice(-15)
      .map(r => `${dirLabel(r)}: ${(r.message || "").slice(0, 300)}`)
      .join("\n") || "(no prior messages)"

    const lastInboundDate = (events || [])
      .filter(r => r.twilio_number && (r.message || "").trim().length > 0)
      .slice(-1)[0]?.created_at || null

    const sharedContext = `LEAD CONTEXT:
- Name: ${anchor.name || "(unknown)"}
- Property: ${anchor.property_address || "(unknown)"}
- Status: ${anchor.status}
- Campaign: ${anchor.campaign_label || anchor.source || "(unknown)"}
- Last inbound: ${lastInboundDate || "(none)"}
${anchor.ai_summary ? `- Summary: ${anchor.ai_summary}\n` : ""}

PRIOR MESSAGES (oldest → newest, may be empty):
${transcript}`

    const prompt = channel === "imessage"
      ? `You are drafting a text message from Ryan, a cash home buyer in the Bay Area. This is a MANUAL follow-up (not part of the automated drip). Write as if Ryan typed it himself.

RULES:
- 1-3 sentences. Sound human. No emojis.
- Reference specific context from the conversation (property, last topic discussed, etc.)
- Goal: re-engage, get them on a phone call.
- No sign-off.

${sharedContext}

Output ONLY the message body — no preamble, no quotes, no labels.`
      : `You are drafting a follow-up email from Ryan, a cash home buyer in the Bay Area. Write as if Ryan typed it himself.

RULES:
- 3-6 sentences. Professional but casual.
- Reference the property or prior conversation specifically.
- End with "— Ryan" only.
- No emojis.

Respond as JSON only (no markdown):
{ "subject": "<short, specific, not salesy>", "body": "<the email body, ending with — Ryan>" }

${sharedContext}`

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: channel === "email" ? 350 : 200,
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!res.ok) {
      return NextResponse.json(
        { error: `OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}` },
        { status: 502 }
      )
    }
    const json = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = json.choices?.[0]?.message?.content?.trim() || ""
    if (!content) return NextResponse.json({ error: "empty model response" }, { status: 502 })

    if (channel === "imessage") {
      const message = content.replace(/^["'`]+|["'`]+$/g, "").trim()
      return NextResponse.json({ message })
    }

    // Email: parse JSON. Be lenient — strip code fences if present.
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
    let parsed: { subject?: string; body?: string }
    try {
      parsed = JSON.parse(cleaned) as { subject?: string; body?: string }
    } catch {
      // Fallback: treat the whole thing as the body, generate a subject.
      parsed = {
        subject: anchor.property_address ? `Quick follow-up about ${anchor.property_address}` : "Quick follow-up",
        body: cleaned,
      }
    }
    return NextResponse.json({
      subject: (parsed.subject || "").trim() || "Quick follow-up",
      message: (parsed.body || "").trim(),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
