import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

export const dynamic = "force-dynamic"
export const revalidate = 0

// Touch summary + full interaction history for a contact, read from Supabase
// `relationship_touches`. Until 2026-09-23 this proxied the sidecar, which
// was still reading a 7-entry outreach_log.json frozen on 2026-04-12 — the
// card's "# of touches" / "Last message" and the modal's interaction history
// had been blind to every touch since the Supabase migration (415 rows: sends,
// Log Call notes, Twilio calls). No sidecar dependency now, so it also works
// when the Mac mini is down.

const MANUAL_MARK = "[marked contacted manually]"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const phone = url.searchParams.get("phone") || ""
  const full = url.searchParams.get("full") === "1"
  if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 })
  const norm = phone.replace(/\D/g, "").slice(-10)
  const empty = { count: 0, lastSentAt: null, lastMessagePreview: null, hasReply: false, history: [] }
  if (norm.length < 10) return NextResponse.json(empty)

  try {
    const sb = getLeadsClient()
    // Phones are stored E.164; a last-10-digit LIKE matches the row.
    const { data: rels } = await sb.from("relationships").select("id").like("phone", `%${norm}`).limit(5)
    const ids = (rels ?? []).map(r => r.id)
    if (ids.length === 0) return NextResponse.json(empty)

    const { data: rows, error } = await sb
      .from("relationship_touches")
      .select("id, occurred_at, modality, action, message, replied_at, call_status, call_duration_sec, recording_url")
      .in("relationship_id", ids)
      .order("occurred_at", { ascending: false })
      .limit(500)
    if (error) throw error
    const touches = rows ?? []

    const sent = touches.filter(t => t.action === "sent")
    const lastSent = sent[0] ?? null
    const preview = sent.find(t => t.message && t.message !== MANUAL_MARK)?.message ?? null
    const out = {
      count: sent.length,
      lastSentAt: lastSent?.occurred_at ?? null,
      lastMessagePreview: preview ? String(preview).slice(0, 140) : null,
      hasReply: touches.some(t => !!t.replied_at),
      history: full
        ? touches.map(t => ({
            id: t.id,
            timestamp: t.occurred_at,
            modality: t.modality || "",
            action: t.action || "",
            message: t.message || "",
            replied: !!t.replied_at,
            callStatus: t.call_status ?? null,
            callDurationSec: t.call_duration_sec ?? null,
            hasRecording: !!t.recording_url,
          }))
        : [],
    }
    return NextResponse.json(out)
  } catch (err) {
    return NextResponse.json({ ...empty, error: String(err) }, { status: 500 })
  }
}
