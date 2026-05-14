import { NextRequest, NextResponse } from "next/server"

// Forecast → pending: kick the engine for a single lead so it generates the
// next touch via Haiku and writes a pending drip_queue row. The UI's next
// /api/drips refresh will surface the row in Due.

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  let body: { leadId?: unknown } = {}
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  const leadId = typeof body.leadId === "string" ? body.leadId : null
  if (!leadId || !UUID_RE.test(leadId)) {
    return NextResponse.json({ error: "leadId must be a UUID" }, { status: 400 })
  }

  try {
    const res = await fetch(`${SIDECAR_URL}/drip-trigger-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId }),
      signal: AbortSignal.timeout(5000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return NextResponse.json({ error: body?.error || `sidecar HTTP ${res.status}` }, { status: 502 })
    return NextResponse.json({ ok: true, leadId, sidecar: body }, { status: 202 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `sidecar unreachable: ${msg}` }, { status: 502 })
  }
}
