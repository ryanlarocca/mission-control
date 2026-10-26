import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { LONG_TRANSCRIPT, summarizeHistoryLine } from "@/lib/lead-history"

// Writes the one-line summary (`leads.history_line`) for long call /
// voicemail transcripts the first time a Follow Ups card shows them, so each
// call is summarised once and reused after that. The card sends the ids its
// history marked `needsLine`; returns { lines: { [id]: line } } for the ones
// it could write. A row that already has a line just returns it.
export const dynamic = "force-dynamic"
export const maxDuration = 60

const MAX_IDS = 8

export async function POST(request: NextRequest) {
  let ids: string[] = []
  try {
    const body = await request.json()
    ids = Array.isArray(body?.ids) ? body.ids.filter((x: unknown): x is string => typeof x === "string") : []
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  ids = Array.from(new Set(ids)).slice(0, MAX_IDS)
  if (ids.length === 0) return NextResponse.json({ lines: {} })

  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("leads")
      .select("id, lead_type, twilio_number, message, history_line")
      .in("id", ids)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const lines: Record<string, string> = {}
    await Promise.all(
      ((data ?? []) as { id: string; lead_type: string | null; twilio_number: string | null; message: string | null; history_line: string | null }[]).map(async (r) => {
        if (r.history_line?.trim()) { lines[r.id] = r.history_line.trim(); return }
        if (r.lead_type !== "call" && r.lead_type !== "voicemail") return
        const transcript = (r.message || "").trim()
        if (transcript.length <= LONG_TRANSCRIPT) return
        const dir = r.twilio_number ? "in" : "out"
        const line = await summarizeHistoryLine({
          kind: r.lead_type === "voicemail" && dir === "in" ? "voicemail" : "call",
          dir,
          transcript,
        })
        if (!line) return
        const { error: upErr } = await sb.from("leads").update({ history_line: line }).eq("id", r.id)
        if (upErr) console.error(`[history-lines] save failed for ${r.id}:`, upErr.message)
        lines[r.id] = line
      })
    )
    return NextResponse.json({ lines })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[history-lines] error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
