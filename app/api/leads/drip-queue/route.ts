import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Drip queue: read pending/approved/skipped touches for the Mission
// Control approval UI. Auth-gated by middleware.
//
// GET  /api/leads/drip-queue                → { items: DripQueueRow[] }
// PATCH /api/leads/drip-queue               → body { id, action: "approve"|"skip" }
//
// The drip engine drains rows where status="approved" on its hourly pass,
// sends them, and flips the row to status="sent". Skipped rows stay in the
// table for audit but the engine ignores them — counters were already
// advanced when the row was queued, so the cadence picks up at the next
// touch on the next due check.

interface DripQueueRow {
  id: string
  lead_id: string
  touch_number: number
  campaign_type: string
  channel: "imessage" | "email"
  message: string
  subject: string | null
  status: "pending" | "approved" | "skipped" | "sent" | "failed"
  created_at: string
  approved_at: string | null
  sent_at: string | null
  error: string | null
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl
  const status = url.searchParams.get("status") || "pending"
  const limitParam = parseInt(url.searchParams.get("limit") || "100", 10)
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(500, limitParam)) : 100

  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("drip_queue")
      .select("*")
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(limit)
    if (error) {
      console.error("[drip-queue:GET] Query failed:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ items: (data ?? []) as DripQueueRow[] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  let body: { id?: string; action?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const { id, action } = body
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "id is required" }, { status: 400 })
  }
  if (action !== "approve" && action !== "skip") {
    return NextResponse.json({ error: 'action must be "approve" or "skip"' }, { status: 400 })
  }

  try {
    const sb = getLeadsClient()
    const update: Record<string, unknown> =
      action === "approve"
        ? { status: "approved", approved_at: new Date().toISOString() }
        : { status: "skipped" }
    // Only flip pending rows; ignore re-clicks on already-decided rows so
    // approval can't accidentally resurrect a skipped touch.
    const { data, error } = await sb
      .from("drip_queue")
      .update(update)
      .eq("id", id)
      .eq("status", "pending")
      .select()
      .single()
    if (error) {
      console.error(`[drip-queue:PATCH] ${action} failed:`, error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ item: data })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
