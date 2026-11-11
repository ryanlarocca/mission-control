import { NextResponse } from "next/server"
import { sidecarHeaders } from "@/lib/sidecar"
import { getLeadsClient } from "@/lib/leads"
import { to10Digit } from "@/lib/relationships"
import { mergeEnrichedNotes } from "@/lib/relationshipNotes"

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
        headers: sidecarHeaders(),
        body: JSON.stringify({ phone }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!res.ok) {
        return NextResponse.json({ enriched: false, reason: "sidecar error" })
      }

      const data = await res.json()

      // Persist to Supabase. The sidecar still writes the (now-frozen) BoB
      // sheet, so post-migration the app owns persistence. Since 2026-11-11
      // the summary is merged in, not written over the field: dated notes,
      // hand notes and intake notes stay; only the previous summary is
      // replaced (lib/relationshipNotes). No new messages → nothing changes.
      if (!data?.enriched || typeof data?.note !== "string" || !data.note.trim()) {
        return NextResponse.json({ enriched: false, reason: "no message history to summarize" })
      }
      const tenDigit = to10Digit(phone)
      let merged: string | null = null
      if (tenDigit.length === 10) {
        try {
          const sb = getLeadsClient()
          const { data: rows } = await sb.from("relationships").select("id, notes").eq("phone", `+1${tenDigit}`)
          for (const r of (rows ?? []) as { id: string; notes: string | null }[]) {
            const next = mergeEnrichedNotes(r.notes, data.note)
            const { error } = await sb.from("relationships").update({ notes: next, enriched_at: new Date().toISOString() }).eq("id", r.id)
            if (error) console.error("crms/enrich-one: failed to persist note to Supabase:", error.message)
            else merged ??= next
          }
        } catch (e) {
          console.error("crms/enrich-one: failed to persist note to Supabase:", e)
        }
      }

      return NextResponse.json({ enriched: true, note: merged ?? mergeEnrichedNotes(null, data.note), lastContacted: data.lastContacted })
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
