import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, type LeadStatus } from "@/lib/leads"

const VALID_STATUSES: LeadStatus[] = ["new", "hot", "qualified", "junk", "contacted"]

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
  let body: { id?: string; status?: string; notes?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const { id, status, notes } = body
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "id is required" }, { status: 400 })
  }
  if (status !== undefined && !VALID_STATUSES.includes(status as LeadStatus)) {
    return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 })
  }
  const update: Record<string, unknown> = {}
  if (status !== undefined) update.status = status
  if (notes !== undefined) update.notes = notes
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
