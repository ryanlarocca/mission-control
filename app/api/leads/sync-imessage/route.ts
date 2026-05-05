import { NextRequest, NextResponse } from "next/server"

// Lead-pipeline auxiliary: when a lead card is expanded in the Leads tab,
// the UI calls this to pull any iMessage/SMS history for the lead's phone
// out of the Mac mini's chat.db (via the CRMS sidecar — it has FDA + the
// readonly handle on chat.db). This is auth-gated by default through the
// session-cookie middleware. Best-effort: any sidecar failure resolves to
// an empty list so the lead card still renders without these merged events.
//
// The companion sidecar endpoint is `/sync-imessage` (see crms-sidecar.js).
// Sidecar URL is `SIDECAR_URL` (local: http://localhost:5799; prod: the
// Cloudflare tunnel domain), already used by /api/crms/* routes.

interface SyncIMessageBody {
  phone?: string
}

export async function POST(request: NextRequest) {
  let body: SyncIMessageBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const phone = (body?.phone || "").trim()
  if (!phone) {
    return NextResponse.json({ error: "phone is required" }, { status: 400 })
  }
  const sidecarUrl = process.env.SIDECAR_URL?.replace(/\/+$/, "")
  if (!sidecarUrl) {
    console.error("[sync-imessage] SIDECAR_URL not set")
    return NextResponse.json({ messages: [] })
  }
  try {
    const res = await fetch(`${sidecarUrl}/sync-imessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      console.warn(`[sync-imessage] Sidecar returned ${res.status}`)
      return NextResponse.json({ messages: [] })
    }
    const data = await res.json()
    return NextResponse.json({ messages: data.messages || [] })
  } catch (e) {
    console.error("[sync-imessage] Sidecar call failed:", e)
    // Best-effort: the lead card stays usable without iMessage merge.
    return NextResponse.json({ messages: [] })
  }
}
