import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, normalizePhone, type LeadStatus } from "@/lib/leads"

const VALID_STATUSES: LeadStatus[] = [
  "new",
  "hot",
  "qualified",
  "warm",
  "junk",
  "contacted",
  // Phase 7B drip statuses
  "active",
  "unqualified",
  "do_not_contact",
]

export async function GET(request: NextRequest) {
  const url = request.nextUrl
  const status = url.searchParams.get("status")
  const source = url.searchParams.get("source")
  const limitParam = parseInt(url.searchParams.get("limit") || "100", 10)
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(500, limitParam)) : 100

  try {
    const sb = getLeadsClient()
    let q = sb.from("leads").select("*").order("created_at", { ascending: false }).limit(limit)
    if (status && VALID_STATUSES.includes(status as LeadStatus)) q = q.eq("status", status)
    if (source) q = q.eq("source", source)
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

export async function PATCH(request: NextRequest) {
  let body: { id?: string; status?: string; notes?: string; caller_phone?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const { id, status, notes, caller_phone } = body
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "id is required" }, { status: 400 })
  }
  if (status !== undefined && !VALID_STATUSES.includes(status as LeadStatus)) {
    return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 })
  }
  const update: Record<string, unknown> = {}
  if (status !== undefined) update.status = status
  if (notes !== undefined) update.notes = notes
  if (caller_phone !== undefined) {
    // Empty/null clears the field (e.g. fixing a typo). Otherwise normalize
    // to E.164 so calls/sms group cleanly with future inbound events.
    if (caller_phone === null || caller_phone === "") {
      update.caller_phone = null
    } else {
      const normalized = normalizePhone(caller_phone)
      if (!/^\+\d{10,15}$/.test(normalized)) {
        return NextResponse.json(
          { error: `Invalid phone format: "${caller_phone}"` },
          { status: 400 }
        )
      }
      update.caller_phone = normalized
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
