import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Drip queue: read pending/approved/skipped touches for the Mission
// Control approval UI. Auth-gated by middleware.
//
// GET  /api/leads/drip-queue                → { items: DripQueueRow[] }
// PATCH /api/leads/drip-queue               → body { id, action: "approve"|"skip"|"edit", message?, subject? }
//
// "edit" rewrites the pending row's message (and optionally subject) so Ryan
// can tweak Haiku's draft before approving. Only allowed while status=pending.
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

const SNOOZE_DAYS = new Set([1, 3, 7])

export async function PATCH(request: NextRequest) {
  let body: { id?: string; action?: string; message?: string; subject?: string; days?: number } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const { id, action, message, subject, days } = body
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "id is required" }, { status: 400 })
  }
  if (action !== "approve" && action !== "skip" && action !== "edit" && action !== "snooze") {
    return NextResponse.json({ error: 'action must be "approve", "skip", "edit", or "snooze"' }, { status: 400 })
  }
  if (action === "snooze" && (typeof days !== "number" || !SNOOZE_DAYS.has(days))) {
    return NextResponse.json({ error: "snooze days must be 1, 3, or 7" }, { status: 400 })
  }

  try {
    const sb = getLeadsClient()

    // Edit: replace message/subject on a pending row only. Returns the
    // updated row so the UI can refresh inline without a re-fetch.
    if (action === "edit") {
      if (typeof message !== "string" || message.trim().length === 0) {
        return NextResponse.json({ error: "message must be a non-empty string" }, { status: 400 })
      }
      const update: Record<string, unknown> = { message: message.trim() }
      if (typeof subject === "string") update.subject = subject.trim() || null
      const { data, error } = await sb
        .from("drip_queue")
        .update(update)
        .eq("id", id)
        .eq("status", "pending")
        .select()
        .maybeSingle()
      if (error) {
        console.error("[drip-queue:PATCH edit] failed:", error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      if (!data) return NextResponse.json({ error: "row not found or not pending" }, { status: 409 })
      return NextResponse.json({ item: data })
    }

    // Snooze: push a pending row's send date out by N days. Touch number is
    // unchanged. The GET /api/drips response filters rows where
    // snoozed_until > now() so they drop out of Late/Due/Coming up; once the
    // timestamp passes, the row resurfaces. We do NOT touch the lead's
    // last_drip_sent_at — when Ryan eventually approves+sends the row, the
    // engine stamps the clock at send time (the canonical pattern).
    if (action === "snooze") {
      const until = new Date(Date.now() + (days as number) * 86400 * 1000).toISOString()
      const { data, error } = await sb
        .from("drip_queue")
        .update({ snoozed_until: until })
        .eq("id", id)
        .in("status", ["pending", "approved", "failed"])
        .select()
        .maybeSingle()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!data) return NextResponse.json({ error: "row not found or not pending/approved/failed" }, { status: 409 })
      return NextResponse.json({ item: data })
    }

    // Approve-time staleness check: if there's been any non-drip human
    // contact (inbound or outbound) on this lead since the queue row was
    // created, the drafted message is out of date. Auto-skip and surface
    // a 409 so the engine regenerates with current context on the next pass.
    if (action === "approve") {
      const { data: queueRow, error: qErr } = await sb
        .from("drip_queue")
        .select("id, lead_id, created_at, status")
        .eq("id", id)
        .maybeSingle()
      if (qErr) {
        console.error("[drip-queue:PATCH] queue lookup failed:", qErr)
        return NextResponse.json({ error: qErr.message }, { status: 500 })
      }
      if (!queueRow || queueRow.status !== "pending") {
        return NextResponse.json({ error: "queue row is not pending" }, { status: 409 })
      }

      const { data: leadRow } = await sb
        .from("leads")
        .select("caller_phone, email")
        .eq("id", queueRow.lead_id)
        .maybeSingle()

      if (leadRow?.caller_phone || leadRow?.email) {
        let q = sb
          .from("leads")
          .select("id, lead_type, created_at")
          .gt("created_at", queueRow.created_at)
          .limit(1)
        if (leadRow.caller_phone) q = q.eq("caller_phone", leadRow.caller_phone)
        else q = q.eq("email", leadRow.email!)

        const { data: newer } = await q
        const stale = (newer || []).some(
          (r) => r.lead_type && !r.lead_type.startsWith("drip_")
        )
        if (stale) {
          await sb
            .from("drip_queue")
            .update({ status: "skipped", error: "stale_after_human_reply" })
            .eq("id", id)
            .eq("status", "pending")
          return NextResponse.json(
            { error: "Stale draft — human contact happened since this was queued. Auto-skipped; the engine will regenerate next pass." },
            { status: 409 }
          )
        }
      }
    }

    const update: Record<string, unknown> =
      action === "approve"
        ? { status: "approved", approved_at: new Date().toISOString() }
        : { status: "skipped" }
    // Approve only flips pending rows. Skip accepts pending/failed/approved —
    // pending is the normal Drips-tab Skip, failed is the Dismiss button on a
    // failed touch, and approved covers the case where a row is stuck mid-
    // flight (engine couldn't fire — e.g., sidecar trigger broke) and Ryan
    // wants to take it off the engine's next drain pass. Counters already
    // advanced when the row was queued, so skipping just clears it from the
    // queue.
    const allowedFrom = action === "approve" ? ["pending"] : ["pending", "failed", "approved"]
    // maybeSingle (not single) so a no-op call doesn't throw. .single() in
    // supabase-js v2 throws "Cannot coerce the result to a single JSON object"
    // when the UPDATE matches 0 rows — which is exactly what happens on a
    // double-click of Skip (first request flips status, second hits a row
    // that's no longer in allowedFrom). Treat that as idempotent success
    // after confirming the row already reached the target state, so the UI
    // can dismiss the card without a spurious 500.
    const { data, error } = await sb
      .from("drip_queue")
      .update(update)
      .eq("id", id)
      .in("status", allowedFrom)
      .select()
      .maybeSingle()
    if (error) {
      console.error(`[drip-queue:PATCH] ${action} failed:`, error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data) {
      // Update matched no rows — either the id doesn't exist or the row is
      // already past the allowed-from states. Look it up and decide.
      const targetStatus = action === "approve" ? "approved" : "skipped"
      const { data: existing } = await sb
        .from("drip_queue")
        .select("*")
        .eq("id", id)
        .maybeSingle()
      if (!existing) {
        return NextResponse.json({ error: "row not found" }, { status: 404 })
      }
      if (existing.status === targetStatus) {
        // Already where we wanted it — idempotent success.
        return NextResponse.json({ item: existing, alreadyApplied: true })
      }
      return NextResponse.json(
        { error: `cannot ${action} row with status=${existing.status}` },
        { status: 409 }
      )
    }

    // Skip advances the cadence clock: "skip = I'm handling this myself,
    // move on." Without this, the next touch's eligibility is based on
    // whatever last_drip_sent_at was at the SKIPPED touch's queue time —
    // which, for a touch Ryan deliberately decided NOT to send, would
    // re-queue touch #N+1 the moment its delay elapses from that stale
    // anchor. Resetting to now means: "treat this skip as if a touch fired
    // here; the next one is X days from now." Active conversations still
    // get an additional push via the engine's `hasActiveConversation`
    // hold on the next pass, so engaged leads aren't accidentally messaged.
    if (action === "skip" && data.lead_id) {
      const skipAt = new Date().toISOString()
      const { error: leadUpErr } = await sb
        .from("leads")
        .update({ last_drip_sent_at: skipAt })
        .eq("id", data.lead_id)
      if (leadUpErr) console.warn("[drip-queue:PATCH skip] lead clock update failed:", leadUpErr.message)
    }

    return NextResponse.json({ item: data })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
