import { NextRequest, NextResponse } from "next/server"
import {
  getLeadsClient,
  normalizePhone,
  VALID_LEAD_STATUSES,
  LEAD_FLAG_FIELDS,
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

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  }

  try {
    const sb = getLeadsClient()
    const { data, error } = await sb.from("leads").update(update).eq("id", id).select().single()
    if (error) {
      console.error("[leads:PATCH] Update failed:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
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
