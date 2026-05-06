import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Phase 7C — Part 3: cached AI lead summary.
//
// On card expand, the UI POSTs this. Behavior:
//   * If ai_summary is set AND ai_summary_generated_at is newer than the
//     most recent lead-event timestamp on this contact → return cached.
//   * Otherwise: gather all events for the contact (matching by phone
//     OR email), call Haiku with a fixed prompt, store + return.
//
// The freshness check uses the union of caller_phone and email since
// LeadGroup events span both keys (a phone/email pair shares a card).
// Cache invalidation is implicit: a new event row updates the contact's
// most-recent timestamp, and the next summary call regenerates.

const HAIKU_MODEL = "anthropic/claude-haiku-4-5"

interface EventRow {
  id: string
  created_at: string
  lead_type: string | null
  twilio_number: string | null
  caller_phone: string | null
  email: string | null
  message: string | null
  source: string | null
  campaign_label: string | null
  property_address: string | null
  name: string | null
}

function isOutbound(r: EventRow): boolean {
  return !r.twilio_number
}

function dirLabel(r: EventRow): string {
  if (isOutbound(r)) {
    return r.lead_type?.startsWith("drip_") ? "ryan(drip)" : "ryan"
  }
  return "lead"
}

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: "OPENROUTER_API_KEY not set" }, { status: 500 })
  }

  try {
    const sb = getLeadsClient()
    const { data: anchor, error } = await sb
      .from("leads")
      .select(
        "id, name, email, caller_phone, source, campaign_label, property_address, ai_summary, ai_summary_generated_at"
      )
      .eq("id", id)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!anchor) return NextResponse.json({ error: "lead not found" }, { status: 404 })

    // Pull every event sharing the contact key (phone OR email). LeadGroup
    // logic in the UI groups the same way; mirroring it here keeps the
    // summary consistent with what Ryan's looking at.
    let eventsQuery = sb
      .from("leads")
      .select("id, created_at, lead_type, twilio_number, caller_phone, email, message, source, campaign_label, property_address, name")
      .order("created_at", { ascending: true })
      .limit(80)
    if (anchor.caller_phone) {
      eventsQuery = eventsQuery.eq("caller_phone", anchor.caller_phone)
    } else if (anchor.email) {
      eventsQuery = eventsQuery.eq("email", anchor.email)
    } else {
      eventsQuery = eventsQuery.eq("id", anchor.id)
    }
    const { data: events, error: evErr } = await eventsQuery.returns<EventRow[]>()
    if (evErr) return NextResponse.json({ error: evErr.message }, { status: 500 })
    const rows = events || []

    // Cache check: latest event timestamp vs ai_summary_generated_at.
    const latestEventTs = rows.length > 0
      ? new Date(rows[rows.length - 1].created_at).getTime()
      : 0
    const cachedTs = anchor.ai_summary_generated_at
      ? new Date(anchor.ai_summary_generated_at).getTime()
      : 0
    if (anchor.ai_summary && cachedTs > latestEventTs) {
      return NextResponse.json({
        summary: anchor.ai_summary,
        generated_at: anchor.ai_summary_generated_at,
        cached: true,
      })
    }

    // Build the conversation transcript for the prompt.
    const transcript = rows
      .filter(r => (r.message || "").trim().length > 0)
      .slice(-30)
      .map(r => `[${r.created_at}] ${r.lead_type || "?"} (${dirLabel(r)}): ${(r.message || "").slice(0, 400)}`)
      .join("\n") || "(no recorded events)"

    const prompt = `You are summarizing a real estate lead for a cash home buyer named Ryan.
Produce a 3-5 bullet summary covering:
- Who they are (name, property if known)
- How they came in (source, date)
- Where things stand (last contact, sentiment, any key quotes)
- What's next (pending drip touch, recommended action)

Be concise. No fluff. Use fragments not full sentences.

LEAD DATA:
- Name: ${anchor.name || "(unknown)"}
- Phone: ${anchor.caller_phone || "(none)"}
- Email: ${anchor.email || "(none)"}
- Property: ${anchor.property_address || "(unknown)"}
- Campaign: ${anchor.campaign_label || anchor.source || "(unknown)"}
- Total events: ${rows.length}

EVENTS (oldest → newest):
${transcript}`

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 250,
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
    const summary = json.choices?.[0]?.message?.content?.trim() || null
    if (!summary) {
      return NextResponse.json({ error: "empty model response" }, { status: 502 })
    }

    const generated_at = new Date().toISOString()
    await sb
      .from("leads")
      .update({ ai_summary: summary, ai_summary_generated_at: generated_at })
      .eq("id", id)

    return NextResponse.json({ summary, generated_at, cached: false })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
