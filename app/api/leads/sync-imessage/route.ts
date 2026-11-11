import { NextRequest, NextResponse } from "next/server"
import { sidecarHeaders } from "@/lib/sidecar"
import { getLeadsClient } from "@/lib/leads"
import { reachNumber } from "@/lib/leadPhones"

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
    const pull = async (p: string): Promise<{ timestamp?: number }[]> => {
      const res = await fetch(`${sidecarUrl}/sync-imessage`, {
        method: "POST",
        headers: sidecarHeaders(),
        body: JSON.stringify({ phone: p }),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) {
        console.warn(`[sync-imessage] Sidecar returned ${res.status}`)
        return []
      }
      const data = await res.json()
      return data.messages || []
    }
    // A card with a best number (lib/leadPhones) has two threads on the
    // phone — the number they called from and the one they asked to be
    // reached at. Both belong on the card.
    let best = phone
    try { best = await reachNumber(getLeadsClient(), phone) } catch { /* card's own number only */ }
    if (best === phone) return NextResponse.json({ messages: await pull(phone) })
    const [own, alt] = await Promise.all([pull(phone), pull(best)])
    const messages = [...own, ...alt].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    return NextResponse.json({ messages })
  } catch (e) {
    console.error("[sync-imessage] Sidecar call failed:", e)
    // Best-effort: the lead card stays usable without iMessage merge.
    return NextResponse.json({ messages: [] })
  }
}
