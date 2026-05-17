import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Bulk send a list of drip_queue ids: flip each pending row to approved
// (with staleness check), then ONE call to the sidecar /drip-trigger-drain
// so the engine drains them all in a single pass.
//
// Body: { ids: string[] }

const SIDECAR_URL = (process.env.SIDECAR_URL || "http://localhost:5799").trim()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  let body: { ids?: unknown } = {}
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  const rawIds = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : []
  if (rawIds.length === 0) return NextResponse.json({ error: "ids must be a non-empty array" }, { status: 400 })
  if (rawIds.length > 100) return NextResponse.json({ error: "Max 100 ids per request" }, { status: 400 })
  const ids = rawIds.filter(id => UUID_RE.test(id))
  if (ids.length === 0) return NextResponse.json({ error: "no valid uuids in ids[]" }, { status: 400 })

  const sb = getLeadsClient()
  const { data: queueRows, error: qErr } = await sb
    .from("drip_queue")
    .select("id, lead_id, created_at, status")
    .in("id", ids)
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 })

  const approved: string[] = []
  const skipped: string[] = []
  const alreadyApproved: string[] = []
  const failed: { id: string; error: string }[] = []
  const nowIso = new Date().toISOString()

  const leadIds = Array.from(new Set((queueRows ?? []).map(r => r.lead_id as string)))
  const { data: leadRows } = await sb
    .from("leads")
    .select("id, caller_phone, email")
    .in("id", leadIds)
  const leadById = new Map<string, { caller_phone: string | null; email: string | null }>(
    (leadRows ?? []).map(l => [l.id as string, { caller_phone: l.caller_phone as string | null, email: l.email as string | null }])
  )

  for (const id of ids) {
    const qr = (queueRows ?? []).find(r => r.id === id)
    if (!qr) { failed.push({ id, error: "not found" }); continue }
    if (qr.status === "approved") { alreadyApproved.push(id); continue }
    if (qr.status !== "pending") { failed.push({ id, error: `status=${qr.status}` }); continue }

    const lead = leadById.get(qr.lead_id as string)
    if (lead?.caller_phone || lead?.email) {
      let q = sb.from("leads").select("id, lead_type").gt("created_at", qr.created_at as string).limit(5)
      if (lead.caller_phone) q = q.eq("caller_phone", lead.caller_phone)
      else q = q.eq("email", lead.email!)
      const { data: newer } = await q
      const stale = (newer || []).some(r => r.lead_type && !(r.lead_type as string).startsWith("drip_"))
      if (stale) {
        await sb.from("drip_queue").update({ status: "skipped", error: "stale_after_human_reply" }).eq("id", id).eq("status", "pending")
        skipped.push(id)
        continue
      }
    }

    const { error: uErr } = await sb
      .from("drip_queue")
      .update({ status: "approved", approved_at: nowIso })
      .eq("id", id)
      .eq("status", "pending")
    if (uErr) { failed.push({ id, error: uErr.message }); continue }
    approved.push(id)
  }

  // Trigger one drain pass for everything we just approved.
  let triggered = false
  if (approved.length + alreadyApproved.length > 0) {
    try {
      await fetch(`${SIDECAR_URL}/drip-trigger-drain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      })
      triggered = true
    } catch (e) {
      console.warn("[drips:bulk-send] sidecar trigger failed:", e instanceof Error ? e.message : String(e))
    }
  }

  return NextResponse.json({ approved, alreadyApproved, skipped, failed, triggered }, { status: 202 })
}
