import { NextResponse } from "next/server"

// Proxies to the CRMS FDA sidecar running on localhost:5799
// The sidecar has Full Disk Access and runs crms-enrich-one.js logic directly.
// If the sidecar is not running, returns { enriched: false } gracefully —
// the UI will still generate a message using existing notes.

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"
const SIDECAR_TIMEOUT = 20000 // 20s — enrichment can take a moment

export async function POST(request: Request) {
  try {
    const { phone } = await request.json()
    if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT)

    try {
      const res = await fetch(`${SIDECAR_URL}/enrich-one`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!res.ok) {
        return NextResponse.json({ enriched: false, reason: "sidecar error" })
      }

      const data = await res.json()
      return NextResponse.json({ enriched: true, note: data.note, lastContacted: data.lastContacted })
    } catch (fetchErr: unknown) {
      clearTimeout(timeout)
      const isAbort = fetchErr instanceof Error && fetchErr.name === "AbortError"
      // Sidecar not running or timed out — fail gracefully
      return NextResponse.json({
        enriched: false,
        reason: isAbort ? "timeout" : "sidecar unavailable",
      })
    }
  } catch (err) {
    console.error("crms/enrich-one error:", err)
    return NextResponse.json({ enriched: false, reason: "internal error" })
  }
}
