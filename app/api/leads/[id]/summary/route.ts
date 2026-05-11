import { NextRequest, NextResponse } from "next/server"
import {
  getLeadsClient,
  VALID_TEMPERATURES,
  type Temperature,
} from "@/lib/leads"

// Phase 7D — cached lead summary, multi-event variant.
//
// On card expand, the UI POSTs this. Behavior:
//   * If ai_summary is set AND ai_summary_generated_at is newer than the
//     most recent lead-event timestamp on this contact → return cached.
//   * Otherwise: gather all events for the contact (phone OR email),
//     call Haiku, store ai_summary + temperature + ai_summary_generated_at,
//     return the summary.
//
// Output format matches the single-call analyzer (analyzeCallTranscript):
// short plain paragraph (2-6 sentences) + temperature (hot/warm/cold).
// The UI prepends a temperature badge from the lead row.

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
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  // 2026-05-11 — body { force: true } bypasses the cache check. Used by
  // the refresh icon in the lead card so a click always produces a fresh
  // cluster-aware paragraph, even when a stale ai_summary_generated_at
  // (from a card that was expanded before the recording arrived) still
  // looks newer than every event in the cluster.
  let force = false
  try {
    const body = await request.json().catch(() => ({})) as { force?: unknown }
    force = body?.force === true
  } catch {
    /* empty body is fine */
  }

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
    // Skipped entirely on force=true so the refresh icon always regenerates.
    const latestEventTs = rows.length > 0
      ? new Date(rows[rows.length - 1].created_at).getTime()
      : 0
    const cachedTs = anchor.ai_summary_generated_at
      ? new Date(anchor.ai_summary_generated_at).getTime()
      : 0
    if (!force && anchor.ai_summary && cachedTs > latestEventTs) {
      return NextResponse.json({
        summary: anchor.ai_summary,
        generated_at: anchor.ai_summary_generated_at,
        cached: true,
      })
    }

    // Build the conversation transcript for the prompt. Per-message limit
    // bumped from 400 → 4000 chars (2026-05-11) — a single call transcript
    // can run 3-8k chars, and truncating to 400 made the model hedge
    // with phrases like "the call log ends here" because it was literally
    // seeing the opening sentence and nothing else. 30 rows × 4000 chars
    // ≈ 30k tokens worst case, well inside Haiku's 200k context.
    const transcript = rows
      .filter(r => (r.message || "").trim().length > 0)
      .slice(-30)
      .map(r => `[${r.created_at}] ${r.lead_type || "?"} (${dirLabel(r)}): ${(r.message || "").slice(0, 4000)}`)
      .join("\n") || "(no recorded events)"

    const today = new Date().toISOString().slice(0, 10)
    const prompt = `You are summarizing a real estate lead for Ryan, a cash home buyer. The lead's contact history is below.

TODAY IS ${today}.

Produce a JSON object:

- temperature: one of "hot" | "warm" | "cold"
    hot  = motivated, wants to sell now or within 1-2 months
    warm = interested, 3-6 month timeline, open to exploring
    cold = curious, no timeline, "maybe someday", or unclear

- summary: a plain prose paragraph, 2 to 6 sentences. No headers, no
    bullets, no bold. Cover who the lead is, what their inquiry is about,
    where things stand based on the conversation history, and any obvious
    next-step or urgency cue. Emojis allowed where natural.

Respond with ONLY the JSON — no markdown fences, no explanation.

{ "temperature": "...", "summary": "..." }

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
        max_tokens: 400,
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
    if (!content) {
      return NextResponse.json({ error: "empty model response" }, { status: 502 })
    }
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()

    let summary: string | null = null
    let temperature: Temperature | null = null
    try {
      const parsed = JSON.parse(cleaned) as { temperature?: string; summary?: string }
      if (parsed.summary && typeof parsed.summary === "string") {
        summary = parsed.summary.trim()
      }
      if (
        parsed.temperature &&
        (VALID_TEMPERATURES as readonly string[]).includes(parsed.temperature)
      ) {
        temperature = parsed.temperature as Temperature
      }
    } catch {
      // Fall back: treat the whole cleaned response as the paragraph if it's
      // free text rather than JSON. Better to show a summary than nothing.
      summary = cleaned
    }
    if (!summary) {
      return NextResponse.json({ error: "no summary in model response" }, { status: 502 })
    }

    const generated_at = new Date().toISOString()
    const update: Record<string, unknown> = {
      ai_summary: summary,
      ai_summary_generated_at: generated_at,
    }
    if (temperature) update.temperature = temperature
    await sb.from("leads").update(update).eq("id", id)

    return NextResponse.json({ summary, temperature, generated_at, cached: false })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
