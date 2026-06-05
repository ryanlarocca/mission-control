import { NextRequest, NextResponse } from "next/server"
import {
  getLeadsClient,
  normalizePhone,
  VALID_LEAD_STATUSES,
  LEAD_FLAG_FIELDS,
  haltOutreachForCluster,
  registerManualTouch,
  parsePropertyDetails,
  type LeadStatus,
  type LeadFlagField,
} from "@/lib/leads"

export async function GET(request: NextRequest) {
  const url = request.nextUrl
  const status = url.searchParams.get("status")
  const source = url.searchParams.get("source")
  const campaignLabel = url.searchParams.get("campaign_label")
  const hasFollowup = url.searchParams.get("has_followup")
  const sort = url.searchParams.get("sort")
  const limitParam = parseInt(url.searchParams.get("limit") || "100", 10)
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(500, limitParam)) : 100

  try {
    const sb = getLeadsClient()
    let q = sb.from("leads").select("*").limit(limit)

    if (status && VALID_LEAD_STATUSES.includes(status as LeadStatus)) q = q.eq("status", status)
    if (source) q = q.eq("source", source)
    if (campaignLabel) q = q.eq("campaign_label", campaignLabel)
    if (hasFollowup === "true") q = q.not("recommended_followup_date", "is", null)

    if (sort === "followup_date_asc") {
      q = q.order("recommended_followup_date", { ascending: true, nullsFirst: false })
    } else {
      q = q.order("created_at", { ascending: false })
    }

    const { data, error } = await q
    if (error) {
      console.error("[leads:GET] Query failed:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ leads: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[leads:GET] Threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// Allow-list of patchable columns. Anything else in the body is ignored.
// Suggested-status fields are patchable so the UI can clear them when Ryan
// dismisses an AI suggestion; recommended_followup_date is patchable so the
// Follow-Up tab can snooze / clear from the UI. name/email/property_address
// are patchable so Ryan can hand-correct misparses on the lead card (e.g.
// Google Voice voicemails that come in with name="Google Voice").
const PATCHABLE_TEXT_FIELDS = [
  "notes",
  "campaign_label",
  "suggested_status",
  "suggested_status_reason",
  "followup_reason",
  "name",
  "email",
  "property_address",
] as const
const PATCHABLE_DATE_FIELDS = ["recommended_followup_date"] as const

export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown> = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const id = typeof body.id === "string" ? body.id : null
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 })
  }

  const update: Record<string, unknown> = {}

  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !VALID_LEAD_STATUSES.includes(body.status as LeadStatus)) {
      return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 })
    }
    update.status = body.status
  }

  for (const field of PATCHABLE_TEXT_FIELDS) {
    if (body[field] !== undefined) {
      const v = body[field]
      if (v === null || typeof v === "string") update[field] = v
    }
  }

  for (const field of PATCHABLE_DATE_FIELDS) {
    if (body[field] !== undefined) {
      const v = body[field]
      if (v === null || typeof v === "string") update[field] = v
    }
  }

  // Offer fields (Campaign Performance tab). offer_amount is a number, but
  // we accept null too — that's the "clear" action from the lead card.
  // When offer_amount is set without an explicit offer_verbalized_at, we
  // stamp the timestamp to now() server-side so the UI doesn't have to.
  if (body.offer_amount !== undefined) {
    const v = body.offer_amount
    if (v === null) {
      update.offer_amount = null
      // Clearing offer_amount also clears the timestamp — a null amount with
      // a stamped event date would be inconsistent.
      update.offer_verbalized_at = null
    } else if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      update.offer_amount = v
      if (body.offer_verbalized_at === undefined) {
        // Manual override path — user typed a number in the pencil-edit on
        // the lead card. Stamp the timestamp now so the funnel counts this
        // as today's event.
        update.offer_verbalized_at = new Date().toISOString()
      }
    } else {
      return NextResponse.json({ error: "offer_amount must be a positive number or null" }, { status: 400 })
    }
  }
  if (body.offer_verbalized_at !== undefined) {
    const v = body.offer_verbalized_at
    if (v === null || typeof v === "string") update.offer_verbalized_at = v
    else return NextResponse.json({ error: "offer_verbalized_at must be ISO string or null" }, { status: 400 })
  }

  // Property details — the lead card sends the FULL array (it manages add /
  // edit / remove client-side). Validate + normalize through the shared parser;
  // an empty array clears the block. null also clears.
  if (body.property_details !== undefined) {
    const v = body.property_details
    if (v === null) {
      update.property_details = null
    } else if (Array.isArray(v)) {
      const cleaned = parsePropertyDetails(v)
      update.property_details = cleaned.length > 0 ? cleaned : null
    } else {
      return NextResponse.json({ error: "property_details must be an array or null" }, { status: 400 })
    }
  }

  for (const flag of LEAD_FLAG_FIELDS) {
    if (body[flag] !== undefined) {
      if (typeof body[flag] !== "boolean") {
        return NextResponse.json({ error: `${flag} must be boolean` }, { status: 400 })
      }
      update[flag as LeadFlagField] = body[flag]
    }
  }

  if (body.caller_phone !== undefined) {
    const cp = body.caller_phone
    if (cp === null || cp === "") {
      update.caller_phone = null
    } else if (typeof cp === "string") {
      const normalized = normalizePhone(cp)
      if (!/^\+\d{10,15}$/.test(normalized)) {
        return NextResponse.json({ error: `Invalid phone format: "${cp}"` }, { status: 400 })
      }
      update.caller_phone = normalized
    } else {
      return NextResponse.json({ error: "caller_phone must be string or null" }, { status: 400 })
    }
  }

  // manual_touch is a side-effect flag, not a column: a completed call /
  // hand-sent email or text resets the contact's drip cadence (see
  // registerManualTouch). The Done and Email/Text actions set it; Snooze
  // does not. It can ride alongside a normal field update (the usual case)
  // or arrive on its own.
  const manualTouch = body.manual_touch === true

  if (Object.keys(update).length === 0 && !manualTouch) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  }

  try {
    const sb = getLeadsClient()
    // Apply the column update when there is one; a manual_touch-only call
    // just loads the row so the cadence reset can resolve its cluster.
    const { data, error } =
      Object.keys(update).length > 0
        ? await sb.from("leads").update(update).eq("id", id).select().single()
        : await sb.from("leads").select().eq("id", id).single()
    if (error) {
      console.error("[leads:PATCH] failed:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // "Halt outreach" side effects: if this PATCH flipped is_junk or is_dnc
    // to true — OR set status to "dead" — any pending/approved drips on this
    // lead's cluster + any outstanding follow-up date are now wrong. The
    // engine filters dead/junk/dnc on its hourly pass, but rows queued
    // BEFORE the change still sit in the Drips tab, and an already-approved
    // row would still fire (drainApprovedQueue doesn't re-check status).
    // We sweep them here so marking a lead dead/junk/dnc clears the queued
    // drips + the follow-up date immediately.
    const flaggedHalt =
      update.is_junk === true || update.is_dnc === true || update.status === "dead"
    if (flaggedHalt) {
      try {
        await haltOutreachForCluster(sb, data)
      } catch (sweepErr) {
        // Don't fail the whole PATCH — the flag is already set, the engine
        // will catch the sweep next pass. Just log loudly.
        console.warn(`[leads:PATCH] halt-outreach sweep failed for ${id}:`, sweepErr instanceof Error ? sweepErr.message : String(sweepErr))
      }
    }

    // Follow-up auto-supersession: when a recommended_followup_date is set
    // on this row, clear it on every OTHER row in the cluster. Ryan's mental
    // model is "one follow-up reminder per lead" — without this rule, the
    // Follow-Ups tab surfaces every per-row date that ever got assigned
    // (e.g. a 2-month AI followup AND a 6-month manual one) and the user
    // can't tell which one to act on. Setting a new date is an implicit
    // "kill the others" command. NULL writes are excluded — those are
    // clears, not new schedules, and shouldn't sweep siblings.
    const supersedingFollowup =
      "recommended_followup_date" in update &&
      typeof update.recommended_followup_date === "string" &&
      update.recommended_followup_date.length > 0
    if (supersedingFollowup) {
      try {
        const orParts: string[] = []
        if (data.caller_phone) orParts.push(`caller_phone.eq.${data.caller_phone}`)
        if (data.email) orParts.push(`email.eq.${data.email}`)
        if (orParts.length > 0) {
          const { data: siblings } = await sb.from("leads").select("id").or(orParts.join(","))
          const sibIds = (siblings ?? []).map(r => r.id as string).filter(sid => sid !== id)
          if (sibIds.length > 0) {
            await sb
              .from("leads")
              .update({ recommended_followup_date: null, followup_reason: null })
              .in("id", sibIds)
              .not("recommended_followup_date", "is", null)
          }
        }
      } catch (supersedeErr) {
        console.warn(`[leads:PATCH] followup supersession failed for ${id}:`, supersedeErr instanceof Error ? supersedeErr.message : String(supersedeErr))
      }
    }

    // Manual-touch cadence reset — restart the drip clock + skip queued
    // drips for the cluster so a contact Ryan just reached out to isn't
    // immediately re-surfaced by a stale drip. Best-effort: the user's
    // action already succeeded, a missed reset just re-surfaces next pass.
    if (manualTouch) {
      try {
        await registerManualTouch(sb, data)
      } catch (touchErr) {
        console.warn(`[leads:PATCH] manual-touch cadence reset failed for ${id}:`, touchErr instanceof Error ? touchErr.message : String(touchErr))
      }
    }

    return NextResponse.json({ lead: data })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[leads:PATCH] Threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// Delete one or more lead rows by id. Used by the Leads-tab card's Delete
// button so Ryan can clean up test rows (or junk leads) without dropping
// to the Supabase dashboard. Auth-gated by middleware.
//
// Body: { ids: string[] } — accepts a list because deleting a single
// "lead card" usually means deleting every Supabase row tied to that
// group (multiple inbound emails in one Gmail thread, a call + the
// follow-up SMS, etc.). The UI builds the id list from group.events.
export async function DELETE(request: NextRequest) {
  let body: { ids?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const ids = Array.isArray(body?.ids)
    ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0)
    : []
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids (string[]) is required" }, { status: 400 })
  }

  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("leads")
      .delete()
      .in("id", ids)
      .select("id")
    if (error) {
      console.error("[leads:DELETE] Delete failed:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ deleted: (data ?? []).length, ids: (data ?? []).map((r) => r.id) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[leads:DELETE] Threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
