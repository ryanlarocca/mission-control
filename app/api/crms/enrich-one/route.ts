import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { to10Digit } from "@/lib/relationships"

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

      // Persist the enriched note to Supabase. The sidecar still writes the
      // (now-frozen) BoB sheet, so post-migration the app must own
      // persistence — otherwise the note is lost on the next page load.
      if (typeof data?.note === "string" && data.note.trim()) {
        const tenDigit = to10Digit(phone)
        if (tenDigit.length === 10) {
          try {
            await getLeadsClient()
              .from("relationships")
              .update({ notes: data.note, enriched_at: new Date().toISOString() })
              .eq("phone", `+1${tenDigit}`)
          } catch (e) {
            console.error("crms/enrich-one: failed to persist note to Supabase:", e)
          }
        }
      }

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
