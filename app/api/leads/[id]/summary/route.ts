import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, mergePropertyDetails, parsePropertyDetails, isPlaceholderName } from "@/lib/leads"

// Phase 7D — cached lead summary, multi-event variant.
//
// On card expand, the UI POSTs this. Behavior:
//   * If ai_summary is set AND ai_summary_generated_at is newer than the
//     most recent lead-event timestamp on this contact → return cached.
//   * Otherwise: gather all events for the contact (phone OR email),
//     call Haiku, store ai_summary + ai_summary_generated_at, return it.
//
// SUMMARY-ONLY: this endpoint does NOT write `temperature`. Temperature is
// owned exclusively by analyzeCallTranscript / triageEmailLead so the badge
// can't flip every time Ryan expands a card (that drift was the root of the
// "temperature is inconsistent" complaint). This route still does
// opportunistic identity write-back (name / property_address / email) since
// those are factual and the model just read the full cluster.
//
// Output: short plain paragraph (2-6 sentences). The UI prepends the
// temperature badge from the lead row's own `temperature` column.

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
        "id, name, email, caller_phone, source, campaign_label, property_address, property_details, ai_summary, ai_summary_generated_at"
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
      // Include current name + property_address in the cache-hit payload too
      // so the UI can sync local state even when the model didn't run this
      // pass (a card opened with stale local state otherwise never picks
      // up a name that landed via a prior write).
      return NextResponse.json({
        summary: anchor.ai_summary,
        generated_at: anchor.ai_summary_generated_at,
        cached: true,
        name: anchor.name ?? null,
        property_address: anchor.property_address ?? null,
        email: anchor.email ?? null,
        property_details: parsePropertyDetails(anchor.property_details),
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

- summary: a plain prose paragraph, 2 to 6 sentences. No headers, no
    bullets, no bold. Cover who the lead is, what their inquiry is about,
    where things stand based on the conversation history, and any obvious
    next-step or urgency cue. Emojis allowed where natural.

    ANCHOR ON THE LATEST OUTCOME. The transcript is ordered oldest → newest.
    The MOST RECENT event drives "where things stand" — don't pull
    earlier-optimistic framing forward if the latest conversation ended
    differently. Specifically:
      • If Ryan made an OFFER, capture the dollar amount AND the seller's
        response (accepted / declined / countered / undecided).
      • If the seller declined an offer, the current state is "price gap"
        — say so explicitly, don't soften to "motivated to sell."
      • If the seller asked Ryan to wait / call back later, state the
        timing they gave verbatim.
      • If the latest event is a hostile pass or opt-out, the summary
        should say so as the headline, even if earlier rows were warmer.

    Keep this NARRATIVE — who, what, where it stands, urgency. Hard property
    SPECS go in the structured property_details field below, not in spec-heavy
    sentences here.

- property_details: an ARRAY of property objects — the concrete specs of the
    real estate discussed, the facts Ryan revisits before every callback. ONE
    OBJECT PER DISTINCT PROPERTY (a seller may own several — e.g. a duplex AND
    a single-family; emit one object each). Each object's string fields (null
    for anything not stated — never guess):
      • label: the property's address or a short distinguishing tag — how it's
          told apart from the seller's other properties. Set it whenever an
          address/identifier is given.
      • property_type: "Single-family" | "Duplex" | "Triplex" | "4-plex" |
          "Multifamily" | "Condo" | "Land" | ...
      • units: door count as stated ("2", "4 units").
      • unit_mix: per-unit bed/bath ("1x 3bd/2ba · 1x 2bd/1ba"); single-family
          → just "4bd/2ba".
      • rents: per-unit or total monthly ("$2,800 + $2,100/mo", "~$8k/mo").
      • occupancy: "both occupied, month-to-month", "1 vacant", "owner-occupied".
      • square_footage ("~2,400 sqft"), lot_size ("6,000 sqft lot"),
          year_built ("1978").
      • notes: other pertinent physical detail (condition, reno, ADU potential).
    Return [] when no property specifics were discussed. Don't fabricate.

- name: the lead's stated name from anywhere in the conversation
    history. Best-effort: pick the most confident mention, not a partial
    guess. Null if no name appears in the transcript.

- property_address: any property address the lead mentioned (best-effort,
    even partial — Ryan can clean it up). Null if no address is mentioned.

- email: any email address the lead stated anywhere in the conversation —
    including spoken / spelled-out forms ("john at gmail dot com"),
    normalized to a standard address. Null if none appears.

Respond with ONLY the JSON — no markdown fences, no explanation.

{ "summary": "...", "name": "..." | null, "property_address": "..." | null, "email": "..." | null, "property_details": [ { "label": "..."|null, "property_type": "..."|null, "units": "..."|null, "unit_mix": "..."|null, "rents": "..."|null, "occupancy": "..."|null, "square_footage": "..."|null, "lot_size": "..."|null, "year_built": "..."|null, "notes": "..."|null } ] }

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
        // 400 → 700 to fit the property_details array (a seller with two
        // multi-unit properties can otherwise truncate the JSON mid-object).
        max_tokens: 700,
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
    let extractedName: string | null = null
    let extractedAddress: string | null = null
    let extractedEmail: string | null = null
    let extractedDetails: ReturnType<typeof parsePropertyDetails> = []
    try {
      const parsed = JSON.parse(cleaned) as {
        summary?: string
        name?: unknown
        property_address?: unknown
        email?: unknown
        property_details?: unknown
      }
      if (parsed.summary && typeof parsed.summary === "string") {
        summary = parsed.summary.trim()
      }
      if (typeof parsed.name === "string" && parsed.name.trim()) {
        extractedName = parsed.name.trim()
      }
      if (typeof parsed.property_address === "string" && parsed.property_address.trim()) {
        extractedAddress = parsed.property_address.trim()
      }
      if (typeof parsed.email === "string" && /\S+@\S+\.\S+/.test(parsed.email.trim())) {
        extractedEmail = parsed.email.trim().toLowerCase()
      }
      extractedDetails = parsePropertyDetails(parsed.property_details)
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
    // 2026-05-11 — opportunistic identity write-back. The model just read the
    // full cluster transcript; if it spotted a name / address / email the
    // anchor row doesn't yet have, fill it. EditableInlineField stays as
    // Ryan's correction mechanism for mishearings. This is what makes the
    // workflow fluid: opening a card auto-backfills identity without needing
    // to call anyone back to "trigger" extraction. (temperature is NOT
    // written here — see the file header.)
    if (extractedName && isPlaceholderName(anchor.name)) update.name = extractedName
    if (extractedAddress && !anchor.property_address) {
      update.property_address = extractedAddress
    }
    if (extractedEmail && !anchor.email) update.email = extractedEmail
    // Property details — sticky per-property merge (fill-if-empty, append new,
    // never drop). This is the path that fires on every card expand, so it's
    // what populates the Property block "as Ryan goes through" his leads. Only
    // write when the merge yields something so a property-less refresh doesn't
    // clobber details Ryan hand-entered.
    const mergedDetails = mergePropertyDetails(anchor.property_details, extractedDetails)
    if (mergedDetails.length > 0) update.property_details = mergedDetails
    await sb.from("leads").update(update).eq("id", id)

    // Return the row's CURRENT effective values (post-update) so the UI
    // can sync local state even when this pass didn't write new identity
    // info. Otherwise a card opened with stale local state but whose DB
    // already has the name from a prior write never picks it up on refresh.
    return NextResponse.json({
      summary,
      generated_at,
      cached: false,
      name: (update.name as string | undefined) ?? anchor.name ?? null,
      property_address: (update.property_address as string | undefined) ?? anchor.property_address ?? null,
      email: (update.email as string | undefined) ?? anchor.email ?? null,
      // Effective details post-merge: the merged array if we wrote one, else
      // whatever the row already had (parsed for shape safety).
      property_details:
        (update.property_details as ReturnType<typeof parsePropertyDetails> | undefined) ??
        parsePropertyDetails(anchor.property_details),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
